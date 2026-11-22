// =========================================================================
// SPH WATER — thruster jets / wakes as Smoothed Particle Hydrodynamics
// CPU port of the Maetveis/SPHWaterPhysics compute-shader pipeline:
//   grid:   count -> exclusive prefix sum -> scatter (counting sort, spatially
//           hashed so the domain is unbounded), 27-cell neighbourhood
//   pass 1: density   rho_i = m * sum W_poly6(r_ij)          (+ edge detection)
//           pressure  p_i   = max(k (rho_i - rho_0), 0)       (clamped EOS)
//   pass 2: forces    f_p = -sum m (p_i+p_j)/(2 rho_j) grad W_spiky
//                     f_v =  mu sum m (v_j-v_i)/rho_j  lap W_visc
//   integrate:        a = f/rho ; symplectic Euler ; damped reflective walls
// Additions for submerged jets: actuator-disk emission, turbulent round-jet
// entrainment decay dU/dt = -U^3/(6 U0 D), moving-hull (ellipsoid) boundary
// with two-way impulse exchange, free-surface impact events.
// Coordinates: three.js world (x North, y Up, z East).
// =========================================================================
var SPHWater = (function () {
  "use strict";
  var PI = Math.PI;

  function SPH(opts) {
    opts = opts || {};
    this.rho0 = 1000;
    this.k = opts.k != null ? opts.k : 9.0;        // c^2  [m^2/s^2]   (c = 3 m/s)
    this.mu = opts.mu != null ? opts.mu : 4.0;     // eddy viscosity   [Pa s]
    this.mass = opts.mass != null ? opts.mass : 0.018;
    this.lifeBase = opts.life != null ? opts.life : 1.4;
    this.dtMax = 1 / 120;
    this.layerSpacing = 0.032;
    this.jetD = 0.076;
    this.setH(opts.h || 0.06);
    this.resize(opts.maxN || 2400);
    this.limit = this.maxN;          // adaptive emission budget (<= capacity)
    this.TABLE = 1 << 14;
    this.cellStart = new Uint32Array(this.TABLE + 1);
    this.cellFill = new Uint32Array(this.TABLE);
    this.acc = {};
    this.phase = {};
    this.impacts = [];       // free-surface impacts {x, z, s}
    this.hull = null;        // moving ellipsoid boundary
    this.hullImpulse = new Float64Array(6);
    this.bounds = { mode: "pool", half: 12.5, floorY: -5.5, surfY: 2.5, seabedY: -30 };
    this.current = [0, 0, 0];
    this.stats = { n: 0, rhoMax: 0, rhoMean: 0, nbMean: 0, vMax: 0, edge: 0, ms: 0, substeps: 0 };
    this._seed = 1234567;
  }

  SPH.prototype.setH = function (h) {
    this.h = h; this.h2 = h * h; this.invH = 1 / h;
    this.cPoly6 = 315 / (64 * PI * Math.pow(h, 9));
    this.cSpiky = 45 / (PI * Math.pow(h, 6));
    this.cVisc = 45 / (PI * Math.pow(h, 6));
  };

  SPH.prototype.resize = function (maxN) {
    var old = this.n || 0;
    this.maxN = maxN;
    var F = function () { return new Float64Array(maxN); };
    var keep = ["px", "py", "pz", "vx", "vy", "vz", "age", "life", "u0d", "tcore", "rho", "prs", "surf"];
    var prev = {};
    var self = this;
    keep.forEach(function (k) { prev[k] = self[k]; self[k] = F(); if (prev[k]) self[k].set(prev[k].subarray(0, Math.min(old, maxN))); });
    this.ax = F(); this.ay = F(); this.az = F();
    this.hash = new Uint32Array(maxN);
    this.cx = new Int32Array(maxN); this.cy = new Int32Array(maxN); this.cz = new Int32Array(maxN);
    this.order = new Uint32Array(maxN);
    this._tmp = new Float64Array(maxN);
    this.ck = new Int32Array(maxN);
    this._tmpI = new Int32Array(maxN);
    this.n = Math.min(old, maxN);
  };

  SPH.prototype.clear = function () { this.n = 0; this.acc = {}; this.impacts.length = 0; };

  SPH.prototype._rand = function () { // xorshift (deterministic)
    var x = this._seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this._seed = x >>> 0;
    return (this._seed & 0xffffff) / 0x1000000;
  };
  SPH.prototype._gauss = function () {
    var u = Math.max(1e-9, this._rand()), v = this._rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * v);
  };

  // jet = {x,y,z, dx,dy,dz (unit jet direction), vj (jet speed relative to vehicle),
  //        vbx,vby,vbz (vehicle velocity at exit), radius, thrust}
  SPH.prototype.emitJet = function (id, jet, dt) {
    var vj = jet.vj;
    if (!(vj > 0.15)) { this.acc[id] = 0; return 0; }
    var rate = vj / this.layerSpacing;                // layers per second
    var a = (this.acc[id] || 0) + rate * dt;
    var layers = Math.floor(a);
    this.acc[id] = a - layers;
    if (layers <= 0) return 0;
    layers = Math.min(layers, 12);
    var dx = jet.dx, dy = jet.dy, dz = jet.dz;
    // orthonormal basis around the jet axis
    var tx = Math.abs(dy) < 0.9 ? 0 : 1, ty = Math.abs(dy) < 0.9 ? 1 : 0, tz = 0;
    var e1x = ty * dz - tz * dy, e1y = tz * dx - tx * dz, e1z = tx * dy - ty * dx;
    var l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z); e1x /= l1; e1y /= l1; e1z /= l1;
    var e2x = dy * e1z - dz * e1y, e2y = dz * e1x - dx * e1z, e2z = dx * e1y - dy * e1x;
    var rr = jet.radius * 0.62, u0d = Math.sqrt(4 * Math.abs(jet.thrust) / (PI * this.rho0));
    var tcore = 6 * this.jetD / Math.max(0.3, vj);
    var ph = this.phase[id] || 0, emitted = 0;
    for (var L = 0; L < layers; L++) {
      ph += 0.785398;
      var back = (layers - 1 - L + this.acc[id]) * this.layerSpacing;   // already travelled
      for (var k = 0; k < 5; k++) {
        if (this.n >= this.maxN || this.n >= this.limit) { this.phase[id] = ph; return emitted; }
        var ox = 0, oy = 0, oz = 0;
        if (k > 0) {
          var ang = ph + (k - 1) * PI / 2, ca = Math.cos(ang) * rr, sa = Math.sin(ang) * rr;
          ox = e1x * ca + e2x * sa; oy = e1y * ca + e2y * sa; oz = e1z * ca + e2z * sa;
        }
        var i = this.n++;
        var j1 = this._gauss() * 0.08 * vj, j2 = this._gauss() * 0.08 * vj;
        this.px[i] = jet.x + ox + dx * back; this.py[i] = jet.y + oy + dy * back; this.pz[i] = jet.z + oz + dz * back;
        this.vx[i] = jet.vbx + dx * vj + e1x * j1 + e2x * j2;
        this.vy[i] = jet.vby + dy * vj + e1y * j1 + e2y * j2;
        this.vz[i] = jet.vbz + dz * vj + e1z * j1 + e2z * j2;
        this.age[i] = back / Math.max(0.3, vj);
        this.life[i] = this.lifeBase * (0.8 + 0.4 * this._rand());
        this.u0d[i] = u0d; this.tcore[i] = tcore;
        this.rho[i] = this.rho0; this.prs[i] = 0; this.surf[i] = 1;
        emitted++;
      }
    }
    this.phase[id] = ph;
    return emitted;
  };

  function hash3(ix, iy, iz, mask) {
    return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;
  }

  // counting sort by hashed cell (count -> prefix -> scatter) + data reorder
  SPH.prototype._buildGrid = function () {
    var n = this.n, mask = this.TABLE - 1, invH = this.invH;
    var start = this.cellStart, fill = this.cellFill, hsh = this.hash, cx = this.cx, cy = this.cy, cz = this.cz;
    start.fill(0);
    for (var i = 0; i < n; i++) {
      var ix = Math.floor(this.px[i] * invH), iy = Math.floor(this.py[i] * invH), iz = Math.floor(this.pz[i] * invH);
      cx[i] = ix; cy[i] = iy; cz[i] = iz;
      var hh = hash3(ix, iy, iz, mask); hsh[i] = hh; start[hh + 1]++;
    }
    for (var b = 0; b < this.TABLE; b++) start[b + 1] += start[b];
    fill.fill(0);
    var order = this.order;
    for (var i2 = 0; i2 < n; i2++) { var hb = hsh[i2]; order[start[hb] + fill[hb]++] = i2; }
    // scatter (reorder) particle data so cells are contiguous in memory
    var arrs = ["px", "py", "pz", "vx", "vy", "vz", "age", "life", "u0d", "tcore", "surf"], tmp = this._tmp;
    for (var a = 0; a < arrs.length; a++) {
      var A = this[arrs[a]];
      for (var k = 0; k < n; k++) tmp[k] = A[order[k]];
      this._tmp = A; this[arrs[a]] = tmp; tmp = A;
    }
    this._tmp = tmp;
    var ti = this._tmpI, ints = [cx, cy, cz];
    for (var q = 0; q < 3; q++) {
      var I = ints[q];
      for (var k2 = 0; k2 < n; k2++) ti[k2] = I[order[k2]];
      I.set(ti.subarray(0, n));
    }
    for (var k3 = 0; k3 < n; k3++) ti[k3] = hsh[order[k3]];
    for (var k4 = 0; k4 < n; k4++) hsh[k4] = ti[k4];
    var ck = this.ck;
    for (var k5 = 0; k5 < n; k5++) ck[k5] = (cx[k5] & 1023) | ((cy[k5] & 1023) << 10) | ((cz[k5] & 1023) << 20);
  };

  // own cell + 13 "forward" cells: every pair is visited exactly once
  var FWD = [[0, 0, 0]];
  (function () {
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
      if (dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz > 0)))) FWD.push([dx, dy, dz]);
    }
  })();
  SPH.prototype._halfBuckets = function (ix, iy, iz, outB, outC) {
    var mask = this.TABLE - 1;
    for (var c = 0; c < 14; c++) {
      var o = FWD[c], ex = ix + o[0], ey = iy + o[1], ez = iz + o[2];
      outB[c] = hash3(ex, ey, ez, mask); outC[c] = (ex & 1023) | ((ey & 1023) << 10) | ((ez & 1023) << 20);
    }
  };

  // pass 1 (symmetric): density, clamped-EOS pressure, edge detection
  SPH.prototype._densityPressure = function () {
    var n = this.n, h2 = this.h2, m = this.mass, c6 = this.cPoly6, k = this.k, rho0 = this.rho0;
    var px = this.px, py = this.py, pz = this.pz, cx = this.cx, cy = this.cy, cz = this.cz;
    var start = this.cellStart, rho = this.rho, prs = this.prs, surf = this.surf;
    var nb = this._nbB || (this._nbB = new Uint32Array(14)), nc = this._nbC || (this._nbC = new Int32Array(14)), ck = this.ck;
    var acc = this._dAcc && this._dAcc.length >= n * 5 ? this._dAcc : (this._dAcc = new Float64Array(this.maxN * 5));
    var self0 = h2 * h2 * h2, i, j;
    for (i = 0; i < n; i++) { var o5 = i * 5; acc[o5] = self0; acc[o5 + 1] = 0; acc[o5 + 2] = 0; acc[o5 + 3] = 0; acc[o5 + 4] = 0; }
    var lx = 1e9, ly = 1e9, lz = 1e9;
    for (i = 0; i < n; i++) {
      if (cx[i] !== lx || cy[i] !== ly || cz[i] !== lz) { lx = cx[i]; ly = cy[i]; lz = cz[i]; this._halfBuckets(lx, ly, lz, nb, nc); }
      var xi = px[i], yi = py[i], zi = pz[i], oi = i * 5;
      for (var c = 0; c < 14; c++) {
        var bk = nb[c], key = nc[c];
        j = start[bk]; var je = start[bk + 1];
        if (c === 0 && j <= i) j = i + 1;
        for (; j < je; j++) {
          if (ck[j] !== key) continue;
          var dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi, r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2) continue;
          var q = h2 - r2, w = q * q * q, oj = j * 5;
          acc[oi] += w; acc[oj] += w;
          acc[oi + 1] += 1; acc[oj + 1] += 1;
          acc[oi + 2] += dx; acc[oi + 3] += dy; acc[oi + 4] += dz;
          acc[oj + 2] -= dx; acc[oj + 3] -= dy; acc[oj + 4] -= dz;
        }
      }
    }
    var rhoMax = 0, rhoSum = 0, nbSum = 0, edge = 0, invH = this.invH;
    for (i = 0; i < n; i++) {
      var b5 = i * 5, d = m * c6 * acc[b5], cnt = acc[b5 + 1];
      rho[i] = d > 1e-3 ? d : 1e-3;
      prs[i] = d > rho0 ? k * (d - rho0) : 0;
      // edge particles (reference heuristic): few neighbours or off-centre neighbourhood
      var off = cnt > 0 ? Math.sqrt(acc[b5 + 2] * acc[b5 + 2] + acc[b5 + 3] * acc[b5 + 3] + acc[b5 + 4] * acc[b5 + 4]) / cnt * invH : 1;
      var e = cnt < 18 ? 1 : Math.min(1, off * 3);
      surf[i] = e; if (e > 0.5) edge++;
      if (d > rhoMax) rhoMax = d; rhoSum += d; nbSum += cnt;
    }
    this.stats.rhoMax = rhoMax; this.stats.rhoMean = n ? rhoSum / n : 0; this.stats.nbMean = n ? nbSum / n : 0; this.stats.edge = edge;
  };

  // pass 2 (symmetric): pressure (spiky gradient) + viscosity (laplacian)
  //   a_i -= m (p_i+p_j)/(2 rho_i rho_j) grad W ;  a_i += mu m (v_j-v_i)/(rho_i rho_j) lap W
  SPH.prototype._forces = function () {
    var n = this.n, h = this.h, h2 = this.h2, m = this.mass, cS = this.cSpiky, cV = this.cVisc, mu = this.mu;
    var px = this.px, py = this.py, pz = this.pz, vx = this.vx, vy = this.vy, vz = this.vz;
    var cx = this.cx, cy = this.cy, cz = this.cz, start = this.cellStart, rho = this.rho, prs = this.prs;
    var ax = this.ax, ay = this.ay, az = this.az, i, j;
    for (i = 0; i < n; i++) { ax[i] = 0; ay[i] = 0; az[i] = 0; }
    var nb = this._nbB, nc = this._nbC, ck = this.ck, lx = 1e9, ly = 1e9, lz = 1e9;
    for (i = 0; i < n; i++) {
      if (cx[i] !== lx || cy[i] !== ly || cz[i] !== lz) { lx = cx[i]; ly = cy[i]; lz = cz[i]; this._halfBuckets(lx, ly, lz, nb, nc); }
      var xi = px[i], yi = py[i], zi = pz[i], vxi = vx[i], vyi = vy[i], vzi = vz[i], pi = prs[i], iri = 1 / rho[i];
      var fx = 0, fy = 0, fz = 0;
      for (var c = 0; c < 14; c++) {
        var bk = nb[c], key = nc[c];
        j = start[bk]; var je = start[bk + 1];
        if (c === 0 && j <= i) j = i + 1;
        for (; j < je; j++) {
          if (ck[j] !== key) continue;
          var dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi, r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2 || r2 < 1e-12) continue;
          var r = Math.sqrt(r2), hr = h - r, inv = iri / rho[j];
          var pt = (pi + prs[j]) * 0.5 * m * inv * cS * hr * hr / r;
          var vt = mu * m * inv * cV * hr;
          var gx = vt * (vx[j] - vxi) - pt * dx, gy = vt * (vy[j] - vyi) - pt * dy, gz = vt * (vz[j] - vzi) - pt * dz;
          fx += gx; fy += gy; fz += gz;
          ax[j] -= gx; ay[j] -= gy; az[j] -= gz;
        }
      }
      ax[i] += fx; ay[i] += fy; az[i] += fz;
    }
  };

  // hull = {c:[x,y,z] centre (three), R:[9] local->world (three), r:[3] semi-axes,
  //         v:[3] linear vel (three, at centre), w:[3] angular vel (three), cg:[3]}
  SPH.prototype._integrate = function (dt) {
    var n = this.n, px = this.px, py = this.py, pz = this.pz, vx = this.vx, vy = this.vy, vz = this.vz;
    var ax = this.ax, ay = this.ay, az = this.az, age = this.age, u0d = this.u0d, tcore = this.tcore;
    var cur = this.current, B = this.bounds, H = this.hull, m = this.mass, imp = this.hullImpulse;
    var vMax = 0;
    for (var i = 0; i < n; i++) {
      var nvx = vx[i] + ax[i] * dt, nvy = vy[i] + ay[i] * dt, nvz = vz[i] + az[i] * dt;
      // turbulent round-jet entrainment: |U| decays as dU/dt = -U^3/(6 U0 D)  (exact step)
      if (age[i] > tcore[i] && u0d[i] > 0) {
        var rx = nvx - cur[0], ry = nvy - cur[1], rz = nvz - cur[2], U2 = rx * rx + ry * ry + rz * rz;
        var f = 1 / Math.sqrt(1 + 2 * U2 * dt / (6 * u0d[i]));
        nvx = cur[0] + rx * f; nvy = cur[1] + ry * f; nvz = cur[2] + rz * f;
      }
      var x = px[i] + nvx * dt, y = py[i] + nvy * dt, z = pz[i] + nvz * dt;
      // moving hull boundary (ellipsoid), two-way impulse exchange
      if (H) {
        var qx = x - H.c[0], qy = y - H.c[1], qz = z - H.c[2], R = H.R;
        var lx = R[0] * qx + R[3] * qy + R[6] * qz, ly = R[1] * qx + R[4] * qy + R[7] * qz, lz = R[2] * qx + R[5] * qy + R[8] * qz;
        var sx = lx / H.r[0], sy = ly / H.r[1], sz = lz / H.r[2], s2 = sx * sx + sy * sy + sz * sz;
        if (s2 < 1 && s2 > 1e-12) {
          var sn = 1 / Math.sqrt(s2);
          lx *= sn; ly *= sn; lz *= sn;                               // project to surface
          var gx = lx / (H.r[0] * H.r[0]), gy = ly / (H.r[1] * H.r[1]), gz = lz / (H.r[2] * H.r[2]);
          var nx = R[0] * gx + R[1] * gy + R[2] * gz, ny = R[3] * gx + R[4] * gy + R[5] * gz, nz = R[6] * gx + R[7] * gy + R[8] * gz;
          var nl = Math.sqrt(nx * nx + ny * ny + nz * nz); nx /= nl; ny /= nl; nz /= nl;
          x = H.c[0] + R[0] * lx + R[1] * ly + R[2] * lz + nx * 0.002;
          y = H.c[1] + R[3] * lx + R[4] * ly + R[5] * lz + ny * 0.002;
          z = H.c[2] + R[6] * lx + R[7] * ly + R[8] * lz + nz * 0.002;
          // hull surface velocity at contact
          var ox = x - H.cg[0], oy = y - H.cg[1], oz = z - H.cg[2];
          var hvx = H.v[0] + H.w[1] * oz - H.w[2] * oy, hvy = H.v[1] + H.w[2] * ox - H.w[0] * oz, hvz = H.v[2] + H.w[0] * oy - H.w[1] * ox;
          var wx = nvx - hvx, wy = nvy - hvy, wz = nvz - hvz, vn = wx * nx + wy * ny + wz * nz;
          if (vn < 0) {
            var e = 1.1;                                               // restitution 0.1
            var tvx = wx - vn * nx, tvy = wy - vn * ny, tvz = wz - vn * nz;
            var bx = hvx + 0.92 * tvx - 0.1 * vn * nx, by = hvy + 0.92 * tvy - 0.1 * vn * ny, bz = hvz + 0.92 * tvz - 0.1 * vn * nz;
            var Jx = m * (bx - nvx), Jy = m * (by - nvy), Jz = m * (bz - nvz);   // impulse on particle
            imp[0] -= Jx; imp[1] -= Jy; imp[2] -= Jz;
            imp[3] -= oy * Jz - oz * Jy; imp[4] -= oz * Jx - ox * Jz; imp[5] -= ox * Jy - oy * Jx;
            nvx = bx; nvy = by; nvz = bz;
            void e;
          }
        }
      }
      // arena boundaries (damped reflection, as in the reference integrator)
      if (B.mode === "pool") {
        var hf = B.half;
        if (x > hf) { x = hf; nvx *= -0.4; } else if (x < -hf) { x = -hf; nvx *= -0.4; }
        if (z > hf) { z = hf; nvz *= -0.4; } else if (z < -hf) { z = -hf; nvz *= -0.4; }
        if (y < B.floorY) { y = B.floorY; nvy *= -0.3; nvx *= 0.85; nvz *= 0.85; }
      } else if (y < B.seabedY) { y = B.seabedY; nvy *= -0.3; }
      if (y > B.surfY) {
        if (nvy > 0.15 && this.impacts.length < 64) this.impacts.push({ x: x, z: z, s: m * nvy });
        y = B.surfY; nvy *= -0.25;
      }
      vx[i] = nvx; vy[i] = nvy; vz[i] = nvz; px[i] = x; py[i] = y; pz[i] = z;
      age[i] += dt;
      var sp = nvx * nvx + nvy * nvy + nvz * nvz; if (sp > vMax) vMax = sp;
    }
    this.stats.vMax = Math.sqrt(vMax);
    // remove expired particles (swap-remove)
    var life = this.life;
    for (var k = 0; k < this.n; k++) {
      if (age[k] > life[k]) {
        var last = --this.n;
        if (k !== last) this._copy(last, k);
        k--;
      }
    }
  };

  SPH.prototype._copy = function (src, dst) {
    this.px[dst] = this.px[src]; this.py[dst] = this.py[src]; this.pz[dst] = this.pz[src];
    this.vx[dst] = this.vx[src]; this.vy[dst] = this.vy[src]; this.vz[dst] = this.vz[src];
    this.age[dst] = this.age[src]; this.life[dst] = this.life[src]; this.u0d[dst] = this.u0d[src];
    this.tcore[dst] = this.tcore[src]; this.rho[dst] = this.rho[src]; this.prs[dst] = this.prs[src]; this.surf[dst] = this.surf[src];
    this.cx[dst] = this.cx[src]; this.cy[dst] = this.cy[src]; this.cz[dst] = this.cz[src]; this.ck[dst] = this.ck[src];
  };

  SPH.prototype.step = function (dtFrame) {
    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var ns = Math.max(1, Math.ceil(dtFrame / this.dtMax - 1e-9)), dt = dtFrame / ns;
    this.hullImpulse.fill(0);
    for (var s = 0; s < ns; s++) {
      if (this.n === 0) break;
      this._buildGrid();
      this._densityPressure();
      this._forces();
      this._integrate(dt);
    }
    this._gridValid = false;
    this.stats.n = this.n; this.stats.substeps = ns;
    this.stats.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  };

  // Shepard-normalised SPH interpolation of the velocity field at a point
  // (used to advect marine snow through the jets). Returns kernel coverage.
  SPH.prototype.prepareSampling = function () { if (this.n) this._buildGrid(); this._gridValid = true; };
  SPH.prototype.sampleVelocity = function (x, y, z, out) {
    if (!this._gridValid || this.n === 0) return 0;
    var invH = this.invH, h2 = this.h2, mask = this.TABLE - 1, start = this.cellStart;
    var ix = Math.floor(x * invH), iy = Math.floor(y * invH), iz = Math.floor(z * invH);
    var ws = 0, sx = 0, sy = 0, sz = 0, cov = 0, c6 = this.cPoly6, m = this.mass;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
      var ex = ix + dx, ey = iy + dy, ez = iz + dz, b = hash3(ex, ey, ez, mask);
      for (var j = start[b], je = start[b + 1]; j < je; j++) {
        if (this.cx[j] !== ex || this.cy[j] !== ey || this.cz[j] !== ez) continue;
        var rx = this.px[j] - x, ry = this.py[j] - y, rz = this.pz[j] - z, r2 = rx * rx + ry * ry + rz * rz;
        if (r2 >= h2) continue;
        var q = h2 - r2, w = q * q * q;
        ws += w; sx += w * this.vx[j]; sy += w * this.vy[j]; sz += w * this.vz[j];
        cov += m * c6 * w / Math.max(1, this.rho[j]);
      }
    }
    if (ws <= 0) return 0;
    out[0] = sx / ws; out[1] = sy / ws; out[2] = sz / ws;
    return Math.min(1, cov);
  };

  return { SPH: SPH };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SPHWater;
