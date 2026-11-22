// =========================================================================
// HYDRO ENGINE — 6-DOF rigid body in water using the MuJoCo fluid models
//   * Ellipsoid model (per-geom):  added mass (Tuckerman kappa integrals),
//     blunt/slender quadratic drag with exact ellipsoid projected area,
//     angular drag, Kutta lift, Magnus lift, Stokes viscous resistance.
//   * Inertia-box model (per-body): equivalent inertia box quadratic drag +
//     Stokes viscous resistance (no added mass), as in MuJoCo.
//   * Fossen rigid-body + added-mass Coriolis/centripetal (Munk moment),
//     irrotational current, linear deep-water waves (orbital velocity,
//     Froude-Krylov + added-mass inertia), free-surface buoyancy by volume
//     sampling, thruster K_T(J) model with ventilation, penalty contact.
//   * Linearised implicit Euler ("implicit" integrator in MuJoCo terms)
//     using a numerical Jacobian of all velocity-dependent forces.
// Frames: world NED (x North, y East, z Down), body FRD, origin at CG.
// =========================================================================
var HydroEngine = (function () {
  "use strict";
  var PI = Math.PI;

  // ---------------------------------------------------------------- math
  function cross(a, b, o) {
    var x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
    o[0] = x; o[1] = y; o[2] = z; return o;
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm3(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function mv(M, v, o) { // 3x3 row-major * v
    var x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
    var y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
    var z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
    o[0] = x; o[1] = y; o[2] = z; return o;
  }
  function mtv(M, v, o) { // M^T * v
    var x = M[0] * v[0] + M[3] * v[1] + M[6] * v[2];
    var y = M[1] * v[0] + M[4] * v[1] + M[7] * v[2];
    var z = M[2] * v[0] + M[5] * v[1] + M[8] * v[2];
    o[0] = x; o[1] = y; o[2] = z; return o;
  }
  function quatToMat(q, M) { // q=[w,x,y,z] body->NED (Hamilton)
    var w = q[0], x = q[1], y = q[2], z = q[3];
    M[0] = 1 - 2 * (y * y + z * z); M[1] = 2 * (x * y - w * z); M[2] = 2 * (x * z + w * y);
    M[3] = 2 * (x * y + w * z); M[4] = 1 - 2 * (x * x + z * z); M[5] = 2 * (y * z - w * x);
    M[6] = 2 * (x * z - w * y); M[7] = 2 * (y * z + w * x); M[8] = 1 - 2 * (x * x + y * y);
    return M;
  }
  function eulerToQuat(phi, theta, psi) { // ZYX (Fossen)
    var cr = Math.cos(phi / 2), sr = Math.sin(phi / 2);
    var cp = Math.cos(theta / 2), sp = Math.sin(theta / 2);
    var cy = Math.cos(psi / 2), sy = Math.sin(psi / 2);
    return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
  }
  function matToEuler(M) {
    return {
      roll: Math.atan2(M[7], M[8]),
      pitch: -Math.asin(Math.max(-1, Math.min(1, M[6]))),
      yaw: Math.atan2(M[3], M[0])
    };
  }
  // Solve A x = b for small dense n x n (A row-major, destroyed), partial pivoting
  function solveDense(A, b, n) {
    for (var c = 0; c < n; c++) {
      var piv = c, best = Math.abs(A[c * n + c]);
      for (var r = c + 1; r < n; r++) { var v = Math.abs(A[r * n + c]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-14) return false;
      if (piv !== c) {
        for (var k = 0; k < n; k++) { var t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
        var tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      }
      var d = A[c * n + c];
      for (var r2 = c + 1; r2 < n; r2++) {
        var f = A[r2 * n + c] / d;
        if (f === 0) continue;
        for (var k2 = c; k2 < n; k2++) A[r2 * n + k2] -= f * A[c * n + k2];
        b[r2] -= f * b[c];
      }
    }
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var j = i + 1; j < n; j++) s -= A[i * n + j] * b[j];
      b[i] = s / A[i * n + i];
    }
    return true;
  }

  // ------------------------------------------- MuJoCo ellipsoid properties
  // Tuckerman (1925) virtual-inertia integrals
  //   kappa_i = int_0^inf r_x r_y r_z / sqrt((r_i^2+l)^3 (r_j^2+l)(r_k^2+l)) dl
  // evaluated with l = c (t/(1-t))^2 (smooth at both ends) + composite Simpson.
  function tuckermanKappa(r) {
    var rx = r[0], ry = r[1], rz = r[2], prod = rx * ry * rz;
    var c = (rx * rx + ry * ry + rz * rz) / 3, N = 2048, out = [0, 0, 0];
    for (var ax = 0; ax < 3; ax++) {
      var ri2 = r[ax] * r[ax], rj2 = r[(ax + 1) % 3] * r[(ax + 1) % 3], rk2 = r[(ax + 2) % 3] * r[(ax + 2) % 3];
      var sum = 0;
      for (var n = 0; n <= N; n++) {
        var f = 0;
        if (n < N) {
          var t = n / N, om = 1 - t, s = t / om, lam = c * s * s;
          var dl = 2 * c * s / (om * om);
          var a = ri2 + lam;
          f = prod / Math.sqrt(a * a * a * (rj2 + lam) * (rk2 + lam)) * dl;
        }
        sum += ((n === 0 || n === N) ? 1 : (n % 2 ? 4 : 2)) * f;
      }
      out[ax] = sum / (3 * N);
    }
    return out;
  }

  function ellipsoidProps(r) {
    var V = 4 / 3 * PI * r[0] * r[1] * r[2];
    var kappa = tuckermanKappa(r);
    var mA = [0, 0, 0], IA = [0, 0, 0], ID = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      var j = (i + 1) % 3, k = (i + 2) % 3;
      mA[i] = V * kappa[i] / (2 - kappa[i]);                 // virtual mass / rho
      var dj = r[j] * r[j], dk = r[k] * r[k], diff = dj - dk;
      if (Math.abs(diff) < 1e-12) IA[i] = 0;                  // body of revolution about i
      else IA[i] = (V / 5) * diff * diff * (kappa[k] - kappa[j]) /
                   (2 * diff + (dj + dk) * (kappa[j] - kappa[k])); // virtual inertia / rho
      ID[i] = 8 / 15 * PI * r[i] * Math.pow(Math.max(r[j], r[k]), 4);
    }
    var dmax = Math.max(r[0], r[1], r[2]), dmin = Math.min(r[0], r[1], r[2]);
    var dmid = r[0] + r[1] + r[2] - dmax - dmin;
    return {
      V: V, kappa: kappa, mA: mA, IA: IA, ID: ID,
      Imax: 8 / 15 * PI * dmid * Math.pow(dmax, 4),
      Amax: PI * dmax * dmid,
      rD: (r[0] + r[1] + r[2]) / 3
    };
  }

  // Area of the central section through the shadow boundary (the formula of the
  // MuJoCo docs lemma / engine_passive.c).  It equals the true projected area
  // divided by cos(alpha), alpha = angle between u and the section normal.
  function sectionArea(r, u) {
    var a = Math.pow(r[1] * r[2], 2), b = Math.pow(r[2] * r[0], 2), c = Math.pow(r[0] * r[1], 2);
    var num = a * a * u[0] * u[0] + b * b * u[1] * u[1] + c * c * u[2] * u[2];
    var den = a * u[0] * u[0] + b * u[1] * u[1] + c * u[2] * u[2];
    return PI * Math.sqrt(num / Math.max(1e-30, den));
  }
  // Exact parallel projection of the ellipsoid on the plane normal to unit u:
  //   A = pi rx ry rz sqrt(ux^2/rx^2 + uy^2/ry^2 + uz^2/rz^2)
  function projectedArea(r, u) {
    return PI * r[0] * r[1] * r[2] * Math.sqrt(u[0] * u[0] / (r[0] * r[0]) + u[1] * u[1] / (r[1] * r[1]) + u[2] * u[2] / (r[2] * r[2]));
  }


  // MuJoCo Kutta lift for an ellipsoid r with local velocity lv:
  //   f_K = C_K rho A_sec (v^.n^) (n^ x v) x v
  function kuttaLift(r, lv, ck, rho, o) {
    var a2yz = Math.pow(r[1] * r[2], 2), a2zx = Math.pow(r[2] * r[0], 2), a2xy = Math.pow(r[0] * r[1], 2);
    var pden = a2yz * a2yz * lv[0] * lv[0] + a2zx * a2zx * lv[1] * lv[1] + a2xy * a2xy * lv[2] * lv[2];
    var pnum = a2yz * lv[0] * lv[0] + a2zx * lv[1] * lv[1] + a2xy * lv[2] * lv[2];
    var nv = Math.sqrt(lv[0] * lv[0] + lv[1] * lv[1] + lv[2] * lv[2]);
    var Asec = PI * Math.sqrt(pden / Math.max(1e-30, pnum));
    var cosA = pnum / Math.max(1e-30, nv * pden);
    var nrm = [a2yz * lv[0], a2zx * lv[1], a2xy * lv[2]];
    var kc = cross(nrm, lv, [0, 0, 0]), k = ck * rho * cosA * Asec;
    kc[0] *= k; kc[1] *= k; kc[2] *= k;
    return cross(kc, lv, o);
  }
  // A duct is a ring wing: model its lift as two crossed thin plates
  // (chord along the thrust axis) using the MuJoCo Kutta term.
  var DUCT_PLATES = [[0.032, 0.042, 0.004], [0.032, 0.004, 0.042]];

  function skew(p) { return [0, -p[2], p[1], p[2], 0, -p[0], -p[1], p[0], 0]; }
  function mm3(A, B) {
    var o = new Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
      o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return o;
  }
  function rdrt(R, d) { // R diag(d) R^T
    var o = new Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
      o[i * 3 + j] = R[i * 3] * d[0] * R[j * 3] + R[i * 3 + 1] * d[1] * R[j * 3 + 1] + R[i * 3 + 2] * d[2] * R[j * 3 + 2];
    return o;
  }
  // 6x6 added-mass contribution of a geom about the body origin (per unit density)
  //   M6 = H^T diag(mA, IA) H,  H = [[R^T, -R^T S(p)], [0, R^T]]
  //      = [[A, -A S], [S A, -S A S + J]]
  function geomAddedMass6(R, p, mA, IA) {
    var A = rdrt(R, mA), J = rdrt(R, IA), S = skew(p);
    var AS = mm3(A, S), SA = mm3(S, A), SAS = mm3(SA, S), M = new Float64Array(36);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
      M[i * 6 + j] = A[i * 3 + j];
      M[i * 6 + j + 3] = -AS[i * 3 + j];
      M[(i + 3) * 6 + j] = SA[i * 3 + j];
      M[(i + 3) * 6 + j + 3] = -SAS[i * 3 + j] + J[i * 3 + j];
    }
    return M;
  }
  function frameFromAxis(d) { // rotation whose first column is d (unit)
    var x = d.slice(), t = Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var y = cross(t, x, [0, 0, 0]), ny = norm3(y); y = [y[0] / ny, y[1] / ny, y[2] / ny];
    var z = cross(x, y, [0, 0, 0]);
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  }

  // ------------------------------------------------------------ defaults
  var COEF_AUV = {   // calibrated for a finless torpedo hull + ducted pods
    hull: { blunt: 0.42, slender: 0.04, ang: 0.35, kutta: 0.12, magnus: 0.20 },
    pod:  { blunt: 0.30, slender: 0.05, ang: 0.50, kutta: 1.50, magnus: 0.20 }
  };
  var COEF_MUJOCO = { // MuJoCo fluidcoef defaults
    hull: { blunt: 0.5, slender: 0.25, ang: 1.5, kutta: 1.0, magnus: 1.0 },
    pod:  { blunt: 0.5, slender: 0.25, ang: 1.5, kutta: 1.0, magnus: 1.0 }
  };

  // ============================================================== ENGINE
  function Engine(opts) {
    opts = opts || {};
    this.p = {
      rho: 997, mu: 1.0e-3, g: 9.81,
      mass: 12.0, Irb: [0.10, 0.50, 0.52],
      BG: 0.05, trim: 0.6, hydrostatic: true,
      model: "ellipsoid", addedMass: true, lift: true, freeSurface: true,
      propKT: true, implicit: true, exactArea: true, munkEff: 0.6, fsDampTau: 0.06,
      current: [0, 0, 0],
      surfaceZ: -2.5, floorZ: 5.5, half: 12.5, mode: "pool", seabedZ: 27.5,
      waves: [],
      hMax: 1 / 240,
      prop: { D: 0.076, KT0: 0.40, J0: 1.1 },
      contact: { k: 4000, c: 120, mu: 0.35 },
      hull: { r: [0.405, 0.095, 0.095], c: [0.04, 0, 0] },
      podR: [0.032, 0.042, 0.042]
    };
    for (var key in opts) this.p[key] = opts[key];
    this.coef = JSON.parse(JSON.stringify(COEF_AUV));
    this.pos = [0, 0, 0];
    this.q = [1, 0, 0, 0];
    this.nu = new Float64Array(6);
    this.ext = new Float64Array(6);   // external body wrench (e.g. SPH jet impingement)
    this.t = 0;
    this.R = new Float64Array(9);
    quatToMat(this.q, this.R);
    this.geoms = [];
    this.thrusterGeom = [];
    this.M = new Float64Array(36);
    this.MA = new Float64Array(36);
    this._A = new Float64Array(36);
    this._J = new Float64Array(36);
    this._F = new Float64Array(6);
    this._Fv0 = new Float64Array(6);
    this._Fvk = new Float64Array(6);
    this._nu2 = new Float64Array(6);
    this._t3 = [0, 0, 0]; this._t3b = [0, 0, 0]; this._t3c = [0, 0, 0]; this._t3d = [0, 0, 0];
    this.sub = { hull: 1, c: [0, 0, 0], geoms: [], thr: [], wl: [] };
    this.diag = null;
    this.thrOut = [];
    this._buildHullSamples();
    this._buildContactSpheres();
    this.setThrusters([]);
  }

  Engine.prototype.setCoefPreset = function (name) {
    this.coef = JSON.parse(JSON.stringify(name === "mujoco" ? COEF_MUJOCO : COEF_AUV));
    this._refreshGeomCoef();
  };
  Engine.prototype._refreshGeomCoef = function () {
    for (var i = 0; i < this.geoms.length; i++) {
      var g = this.geoms[i];
      g.coef = g.kind === "hull" ? this.coef.hull : this.coef.pod;
    }
  };

  // thrusters: [{pos:[3], dir:[3]}]  -> composite fluid geoms (hull + pods)
  Engine.prototype.setThrusters = function (thrusters) {
    var P = this.p, geoms = [];
    var hullR = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var hullProps = ellipsoidProps(P.hull.r);
    geoms.push({ kind: "hull", name: "Hull", r: P.hull.r.slice(), pos: P.hull.c.slice(), R: hullR,
                 props: hullProps, coef: this.coef.hull,
                 M6: geomAddedMass6(hullR, P.hull.c, hullProps.mA, hullProps.IA) });
    var podProps = this._podProps || (this._podProps = ellipsoidProps(P.podR));
    this.thrusterGeom = [];
    for (var i = 0; i < thrusters.length; i++) {
      var th = thrusters[i], d = th.dir.slice(), nd = norm3(d);
      d = [d[0] / nd, d[1] / nd, d[2] / nd];
      var R = frameFromAxis(d);
      // A through-hull thruster sits inside the hull envelope: no separate pod.
      var inHull = this._insideHull(th.pos, 0.0);
      this.thrusterGeom.push({ pos: th.pos.slice(), dir: d, inHull: inHull });
      if (inHull) continue;
      geoms.push({ kind: "pod", name: "Pod" + (i + 1), r: P.podR.slice(), pos: th.pos.slice(), R: R,
                   props: podProps, coef: this.coef.pod,
                   M6: geomAddedMass6(R, th.pos, podProps.mA, podProps.IA) });
    }
    this.geoms = geoms;
    this.sub.geoms = geoms.map(function () { return 1; });
    this.sub.thr = thrusters.map(function () { return 1; });
    this._volSum = geoms.reduce(function (s, g) { return s + g.props.V; }, 0);
    this._buildContactSpheres();
  };

  Engine.prototype._insideHull = function (p, pad) {
    var h = this.p.hull, x = (p[0] - h.c[0]) / (h.r[0] + pad), y = (p[1] - h.c[1]) / (h.r[1] + pad), z = (p[2] - h.c[2]) / (h.r[2] + pad);
    return x * x + y * y + z * z < 1;
  };

  Engine.prototype._buildHullSamples = function () {
    var h = this.p.hull, nx = 14, ny = 5, nz = 5, pts = [];
    for (var i = 0; i < nx; i++) for (var j = 0; j < ny; j++) for (var k = 0; k < nz; k++) {
      var u = -1 + (2 * i + 1) / nx, v = -1 + (2 * j + 1) / ny, w = -1 + (2 * k + 1) / nz;
      if (u * u + v * v + w * w <= 1) pts.push([h.c[0] + u * h.r[0], h.c[1] + v * h.r[1], h.c[2] + w * h.r[2]]);
    }
    this.hullPts = pts;
    this.hullCell = 2 * h.r[2] / nz;
  };

  Engine.prototype._buildContactSpheres = function () {
    var h = this.p.hull, s = [];
    [-0.30, -0.12, 0.06, 0.24, 0.36].forEach(function (x) { s.push({ p: [x, 0, 0], r: h.r[1] }); });
    var tg = this.thrusterGeom || [];
    for (var i = 0; i < tg.length; i++) if (!tg[i].inHull) s.push({ p: tg[i].pos.slice(), r: 0.045 });
    this.contactSpheres = s;
  };

  Engine.prototype.setPose = function (x, y, z, roll, pitch, yaw) {
    this.pos = [x, y, z];
    this.q = eulerToQuat(roll || 0, pitch || 0, yaw || 0);
    for (var i = 0; i < 6; i++) this.nu[i] = 0;
    quatToMat(this.q, this.R);
  };

  // ------------------------------------------------------ water kinematics
  Engine.prototype.surfaceZ = function (x, y, t) {
    var z = this.p.surfaceZ, W = this.p.waves;
    for (var i = 0; i < W.length; i++) {
      var w = W[i]; z -= w.a * Math.cos(w.kx * x + w.ky * y - w.omega * t + w.phase);
    }
    return z;
  };
  // water velocity (current + linear wave orbital) and wave acceleration at NED point
  Engine.prototype.waterVelAcc = function (x, y, z, t, vel, acc) {
    var c = this.p.current, W = this.p.waves;
    vel[0] = c[0]; vel[1] = c[1]; vel[2] = c[2];
    if (acc) { acc[0] = 0; acc[1] = 0; acc[2] = 0; }
    if (!W.length) return;
    var d = Math.max(0, z - this.p.surfaceZ);
    for (var i = 0; i < W.length; i++) {
      var w = W[i], k = Math.sqrt(w.kx * w.kx + w.ky * w.ky);
      var th = w.kx * x + w.ky * y - w.omega * t + w.phase;
      var e = Math.exp(-k * d), aw = w.a * w.omega * e, ct = Math.cos(th), st = Math.sin(th);
      var hx = w.kx / k, hy = w.ky / k;
      vel[0] += aw * ct * hx; vel[1] += aw * ct * hy; vel[2] -= aw * st;
      if (acc) { var aa = aw * w.omega; acc[0] += aa * st * hx; acc[1] += aa * st * hy; acc[2] += aa * ct; }
    }
  };

  // ------------------------------------------------ position-dependent set-up
  Engine.prototype._computeSubmergence = function () {
    var P = this.p, R = this.R, pos = this.pos, t = this.t, tmp = this._t3;
    var pts = this.hullPts, cell = this.hullCell, sum = 0, cx = 0, cy = 0, cz = 0;
    var flat = !P.waves.length, zs0 = P.surfaceZ, wl = this.sub.wl = [];
    for (var i = 0; i < pts.length; i++) {
      var pb = pts[i];
      mv(R, pb, tmp);
      var wx = pos[0] + tmp[0], wy = pos[1] + tmp[1], wz = pos[2] + tmp[2];
      var zs = flat ? zs0 : this.surfaceZ(wx, wy, t);
      var s = (wz - zs) / cell + 0.5; s = s < 0 ? 0 : (s > 1 ? 1 : s);
      if (!P.freeSurface) s = 1;
      if (s > 0 && s < 1) wl.push(i);
      sum += s; cx += s * pb[0]; cy += s * pb[1]; cz += s * pb[2];
    }
    var f = sum / pts.length, sub = this.sub;
    sub.hull = f;
    if (sum > 1e-9) { sub.c[0] = cx / sum; sub.c[1] = cy / sum; sub.c[2] = cz / sum; }
    else { sub.c[0] = P.hull.c[0]; sub.c[1] = P.hull.c[1]; sub.c[2] = P.hull.c[2]; }
    // per geom & per thruster (smoothed by size)
    for (var g = 0; g < this.geoms.length; g++) {
      var G = this.geoms[g];
      if (G.kind === "hull") { sub.geoms[g] = f; continue; }
      mv(R, G.pos, tmp);
      var gz = pos[2] + tmp[2], gzs = flat ? zs0 : this.surfaceZ(pos[0] + tmp[0], pos[1] + tmp[1], t);
      var sg = (gz - gzs) / (2 * G.r[2]) + 0.5;
      sub.geoms[g] = P.freeSurface ? (sg < 0 ? 0 : (sg > 1 ? 1 : sg)) : 1;
    }
    var tg = this.thrusterGeom;
    for (var k = 0; k < tg.length; k++) {
      mv(R, tg[k].pos, tmp);
      var tz = pos[2] + tmp[2], tzs = flat ? zs0 : this.surfaceZ(pos[0] + tmp[0], pos[1] + tmp[1], t);
      var st = (tz - tzs) / 0.084 + 0.5;
      sub.thr[k] = P.freeSurface ? (st < 0 ? 0 : (st > 1 ? 1 : st)) : 1;
    }
  };

  Engine.prototype._buildMass = function () {
    var P = this.p, M = this.M, MA = this.MA, i;
    for (i = 0; i < 36; i++) { M[i] = 0; MA[i] = 0; }
    M[0] = M[7] = M[14] = P.mass;
    M[21] = P.Irb[0]; M[28] = P.Irb[1]; M[35] = P.Irb[2];
    if (P.model === "ellipsoid" && P.addedMass) {
      for (var g = 0; g < this.geoms.length; g++) {
        var s = P.rho * this.sub.geoms[g], G6 = this.geoms[g].M6;
        if (s <= 0) continue;
        for (i = 0; i < 36; i++) MA[i] += s * G6[i];
      }
      for (i = 0; i < 36; i++) M[i] += MA[i];
    }
  };

  // hydrostatics + wave excitation (position/time dependent) -> F (6)
  Engine.prototype._positionForces = function (F, D) {
    var P = this.p, R = this.R, sub = this.sub, t3 = this._t3, t3b = this._t3b;
    var W = P.mass * P.g, Bfull = W + P.trim, B = Bfull * sub.hull;
    // gravity at CG, buoyancy at CB
    var fg = mtv(R, [0, 0, W], [0, 0, 0]);
    var fb = mtv(R, [0, 0, -B], [0, 0, 0]);
    var bg = P.hydrostatic ? P.BG : 0;
    var rB = [sub.c[0] - P.hull.c[0], sub.c[1] - P.hull.c[1], sub.c[2] - P.hull.c[2] - bg];
    var tb = cross(rB, fb, [0, 0, 0]);
    for (var i = 0; i < 3; i++) { F[i] += fg[i] + fb[i]; F[3 + i] += tb[i]; }
    if (D) { D.hs = [fg[0] + fb[0], fg[1] + fb[1], fg[2] + fb[2], tb[0], tb[1], tb[2]]; D.B = B; D.W = W; D.rB = rB; }
    // linear-wave Froude-Krylov + added-mass inertia force, per geom
    if (P.waves.length) {
      var kV = (Bfull / (P.rho * P.g)) / this._volSum, acc = [0, 0, 0], vel = [0, 0, 0], wf = [0, 0, 0, 0, 0, 0];
      for (var g = 0; g < this.geoms.length; g++) {
        var G = this.geoms[g], s = sub.geoms[g];
        if (s <= 0) continue;
        mv(R, G.pos, t3);
        this.waterVelAcc(this.pos[0] + t3[0], this.pos[1] + t3[1], this.pos[2] + t3[2], this.t, vel, acc);
        var ab = mtv(R, acc, [0, 0, 0]);
        var al = mtv(G.R, ab, [0, 0, 0]);
        var am = [G.props.mA[0] * al[0], G.props.mA[1] * al[1], G.props.mA[2] * al[2]];
        var amb = mv(G.R, am, [0, 0, 0]);
        var addOn = (P.model === "ellipsoid" && P.addedMass) ? 1 : 0;
        var f = [0, 0, 0];
        for (var a = 0; a < 3; a++) f[a] = P.rho * s * (kV * G.props.V * ab[a] + addOn * amb[a]);
        var tq = cross(G.pos, f, t3b);
        for (var b = 0; b < 3; b++) { wf[b] += f[b]; wf[3 + b] += tq[b]; }
      }
      for (var c = 0; c < 6; c++) F[c] += wf[c];
      if (D) D.wave = wf;
    } else if (D) D.wave = [0, 0, 0, 0, 0, 0];
    for (var e = 0; e < 6; e++) F[e] += this.ext[e];
    if (D) D.ext = Array.prototype.slice.call(this.ext);
  };

  // all velocity-dependent generalized forces for velocity vector nu -> F
  Engine.prototype._velocityForces = function (nu, thr, F, D) {
    var P = this.p, R = this.R, pos = this.pos, t = this.t, sub = this.sub;
    var t3 = this._t3, t3b = this._t3b, t3c = this._t3c, t3d = this._t3d;
    var i, a;
    for (i = 0; i < 6; i++) F[i] = 0;
    var v = [nu[0], nu[1], nu[2]], w = [nu[3], nu[4], nu[5]];
    var vel = [0, 0, 0];
    var rho = P.rho, mu = P.mu;

    // ---- rigid-body Coriolis/centripetal (about CG): -[m w x v ; w x I w]
    var cv = cross(w, v, [0, 0, 0]);
    var Iw = [P.Irb[0] * w[0], P.Irb[1] * w[1], P.Irb[2] * w[2]];
    var cw = cross(w, Iw, [0, 0, 0]);
    var crb = [-P.mass * cv[0], -P.mass * cv[1], -P.mass * cv[2], -cw[0], -cw[1], -cw[2]];
    for (i = 0; i < 6; i++) F[i] += crb[i];

    // water velocity at CG (body)
    this.waterVelAcc(pos[0], pos[1], pos[2], t, vel, null);
    var vcb = mtv(R, vel, [0, 0, 0]);
    var vr = [v[0] - vcb[0], v[1] - vcb[1], v[2] - vcb[2]];

    // ---- added-mass Coriolis (Munk moment etc.) -C_A(nu_r) nu_r - M_A [w x v_c ; 0]
    var cA = [0, 0, 0, 0, 0, 0];
    if (P.model === "ellipsoid" && P.addedMass) {
      var MA = this.MA, a1 = [0, 0, 0], a2 = [0, 0, 0];
      for (i = 0; i < 3; i++) {
        a1[i] = MA[i * 6] * vr[0] + MA[i * 6 + 1] * vr[1] + MA[i * 6 + 2] * vr[2] +
                MA[i * 6 + 3] * w[0] + MA[i * 6 + 4] * w[1] + MA[i * 6 + 5] * w[2];
        a2[i] = MA[(i + 3) * 6] * vr[0] + MA[(i + 3) * 6 + 1] * vr[1] + MA[(i + 3) * 6 + 2] * vr[2] +
                MA[(i + 3) * 6 + 3] * w[0] + MA[(i + 3) * 6 + 4] * w[1] + MA[(i + 3) * 6 + 5] * w[2];
      }
      var f1 = cross(a1, w, [0, 0, 0]);
      var g1 = cross(a1, vr, [0, 0, 0]), g2 = cross(a2, w, [0, 0, 0]);
      var wxvc = cross(w, vcb, [0, 0, 0]);
      for (i = 0; i < 3; i++) {
        var mc = MA[i * 6] * wxvc[0] + MA[i * 6 + 1] * wxvc[1] + MA[i * 6 + 2] * wxvc[2];
        var mt = MA[(i + 3) * 6] * wxvc[0] + MA[(i + 3) * 6 + 1] * wxvc[1] + MA[(i + 3) * 6 + 2] * wxvc[2];
        cA[i] = f1[i] - mc; cA[3 + i] = P.munkEff * g1[i] + g2[i] - mt;
      }
      for (i = 0; i < 6; i++) F[i] += cA[i];
    }

    // ---- fluid drag / lift
    var drag = [0, 0, 0, 0, 0, 0], angd = [0, 0, 0, 0, 0, 0], kut = [0, 0, 0, 0, 0, 0],
        mag = [0, 0, 0, 0, 0, 0], visc = [0, 0, 0, 0, 0, 0];
    if (P.model === "ellipsoid") {
      for (var g = 0; g < this.geoms.length; g++) {
        var G = this.geoms[g], s = sub.geoms[g];
        if (s <= 1e-4) continue;
        var C = G.coef, pr = G.props, r = G.r, Gp = G.pos, GR = G.R;
        // geom-centre velocity relative to water, in body then geom frame
        cross(w, Gp, t3);
        var vgb = [v[0] + t3[0], v[1] + t3[1], v[2] + t3[2]];
        if (P.waves.length) {
          mv(R, Gp, t3b);
          this.waterVelAcc(pos[0] + t3b[0], pos[1] + t3b[1], pos[2] + t3b[2], t, vel, null);
          mtv(R, vel, t3c);
        } else { t3c[0] = vcb[0]; t3c[1] = vcb[1]; t3c[2] = vcb[2]; }
        vgb[0] -= t3c[0]; vgb[1] -= t3c[1]; vgb[2] -= t3c[2];
        var lv = mtv(GR, vgb, [0, 0, 0]), lw = mtv(GR, w, [0, 0, 0]);
        var sx = r[0], sy = r[1], sz = r[2];
        var nv = norm3(lv);
        // Magnus  f_M = C_M rho V (w x v)
        var fm = cross(lw, lv, [0, 0, 0]), km = C.magnus * rho * pr.V * (P.lift ? 1 : 0);
        fm[0] *= km; fm[1] *= km; fm[2] *= km;
        // projected area along velocity
        var a2yz = Math.pow(sy * sz, 2), a2zx = Math.pow(sz * sx, 2), a2xy = Math.pow(sx * sy, 2);
        var pden = a2yz * a2yz * lv[0] * lv[0] + a2zx * a2zx * lv[1] * lv[1] + a2xy * a2xy * lv[2] * lv[2];
        var pnum = a2yz * lv[0] * lv[0] + a2zx * lv[1] * lv[1] + a2xy * lv[2] * lv[2];
        var Asec = PI * Math.sqrt(pden / Math.max(1e-30, pnum));         // MuJoCo "A_proj"
        // Kutta lift  f_K = C_K rho A_sec (v^.n^)(n^ x v) x v   (as MuJoCo)
        var nrm = [a2yz * lv[0], a2zx * lv[1], a2xy * lv[2]];
        var cosA = pnum / Math.max(1e-30, nv * pden);
        var fk = [0, 0, 0];
        if (P.lift && G.kind === "pod") {          // open duct = ring wing
          var fa = kuttaLift(DUCT_PLATES[0], lv, C.kutta, rho, [0, 0, 0]);
          var fb2 = kuttaLift(DUCT_PLATES[1], lv, C.kutta, rho, [0, 0, 0]);
          fk[0] = fa[0] + fb2[0]; fk[1] = fa[1] + fb2[1]; fk[2] = fa[2] + fb2[2];
        } else if (P.lift) {
          var kc = cross(nrm, lv, [0, 0, 0]), kk = C.kutta * rho * cosA * Asec;
          kc[0] *= kk; kc[1] *= kk; kc[2] *= kk;
          cross(kc, lv, fk);
        }
        // drag reference area: exact projection (= A_sec cos(alpha)) or MuJoCo's A_sec
        var Aproj = Asec;
        if (P.exactArea && nv > 1e-9) Aproj = PI * sx * sy * sz * Math.sqrt(lv[0] * lv[0] / (sx * sx) + lv[1] * lv[1] / (sy * sy) + lv[2] * lv[2] / (sz * sz)) / nv;
        // Stokes viscous resistance (equivalent sphere)
        var eqD = 2 / 3 * (sx + sy + sz);
        var linVisc = mu * 3 * PI * eqD, angVisc = mu * PI * eqD * eqD * eqD;
        // quadratic drag (blunt + slender) and angular drag
        var quadLin = rho * nv * (C.blunt * Aproj + C.slender * (pr.Amax - Aproj));
        var mvx = lw[0] * (C.ang * pr.ID[0] + C.slender * (pr.Imax - pr.ID[0]));
        var mvy = lw[1] * (C.ang * pr.ID[1] + C.slender * (pr.Imax - pr.ID[1]));
        var mvz = lw[2] * (C.ang * pr.ID[2] + C.slender * (pr.Imax - pr.ID[2]));
        var quadAng = rho * Math.sqrt(mvx * mvx + mvy * mvy + mvz * mvz);
        // local -> body, transfer to CG, scale by submerged fraction
        var parts = [
          [[-quadLin * lv[0], -quadLin * lv[1], -quadLin * lv[2]], [0, 0, 0], drag],
          [[0, 0, 0], [-quadAng * lw[0], -quadAng * lw[1], -quadAng * lw[2]], angd],
          [fk, [0, 0, 0], kut],
          [fm, [0, 0, 0], mag],
          [[-linVisc * lv[0], -linVisc * lv[1], -linVisc * lv[2]], [-angVisc * lw[0], -angVisc * lw[1], -angVisc * lw[2]], visc]
        ];
        for (var pi = 0; pi < parts.length; pi++) {
          var fl = parts[pi][0], tl = parts[pi][1], acc6 = parts[pi][2];
          var fb = mv(GR, fl, t3d), fbx = fb[0] * s, fby = fb[1] * s, fbz = fb[2] * s;
          var tbv = mv(GR, tl, t3b);
          var arm = cross(Gp, [fbx, fby, fbz], t3c);
          acc6[0] += fbx; acc6[1] += fby; acc6[2] += fbz;
          acc6[3] += tbv[0] * s + arm[0]; acc6[4] += tbv[1] * s + arm[1]; acc6[5] += tbv[2] * s + arm[2];
        }
      }
    } else { // MuJoCo inertia-box model
      var m = P.mass, I = P.Irb, s0 = sub.hull;
      var bx = Math.sqrt(Math.max(1e-9, 1.5 / m * (I[1] + I[2] - I[0])));
      var by = Math.sqrt(Math.max(1e-9, 1.5 / m * (I[2] + I[0] - I[1])));
      var bz = Math.sqrt(Math.max(1e-9, 1.5 / m * (I[0] + I[1] - I[2])));
      var rb = [bx, by, bz], req = (bx + by + bz) / 3;
      for (a = 0; a < 3; a++) {
        var j = (a + 1) % 3, k = (a + 2) % 3;
        drag[a] = -2 * rho * rb[j] * rb[k] * Math.abs(vr[a]) * vr[a] * s0;
        angd[3 + a] = -0.5 * rho * rb[a] * (Math.pow(rb[j], 4) + Math.pow(rb[k], 4)) * Math.abs(w[a]) * w[a] * s0;
        visc[a] = -6 * mu * PI * req * vr[a] * s0;
        visc[3 + a] = -8 * mu * PI * req * req * req * w[a] * s0;
      }
    }
    for (i = 0; i < 6; i++) F[i] += drag[i] + angd[i] + kut[i] + mag[i] + visc[i];

    // ---- thrusters (K_T(J) advance-ratio loss, ventilation, prop torque)
    var tw = [0, 0, 0, 0, 0, 0], tg = this.thrusterGeom, pp = P.prop;
    var Adisk = PI * pp.D * pp.D / 4, rD4 = rho * Math.pow(pp.D, 4) * pp.KT0;
    var outs = D ? (this.thrOut = []) : null;
    for (i = 0; i < tg.length && i < thr.length; i++) {
      var th = tg[i], cmd = thr[i].T, kq = thr[i].kq || 0, sg = this.sub.thr[i];
      var dd = th.dir;
      cross(w, th.pos, t3);
      var vt = [v[0] + t3[0] - vcb[0], v[1] + t3[1] - vcb[1], v[2] + t3[2] - vcb[2]];
      var sign = cmd >= 0 ? 1 : -1, Va = sign * dot(vt, dd);
      var n = Math.sqrt(Math.abs(cmd) / rD4), Teff = 0, J = 0;
      if (n > 1e-6) {
        J = Va / (n * pp.D);
        var phi = P.propKT ? 1 - J / pp.J0 : 1;
        phi = phi < 0 ? 0 : (phi > 1.6 ? 1.6 : phi);
        Teff = sign * rD4 * n * n * phi * sg;
      }
      var ft = [Teff * dd[0], Teff * dd[1], Teff * dd[2]];
      var tq = cross(th.pos, ft, t3b);
      tw[0] += ft[0]; tw[1] += ft[1]; tw[2] += ft[2];
      tw[3] += tq[0] + kq * Teff * dd[0]; tw[4] += tq[1] + kq * Teff * dd[1]; tw[5] += tq[2] + kq * Teff * dd[2];
      if (outs) {
        var vj = Math.sqrt(Math.max(0, Va * Va + 2 * Math.abs(Teff) / (rho * Adisk)));
        outs.push({ T: Teff, n: n, rpm: n * 60, Va: Va, J: J, vj: vj, sub: sg });
      }
    }
    for (i = 0; i < 6; i++) F[i] += tw[i];

    // ---- free-surface (wave-radiation) damping at waterline samples:
    //      c_i = k_i * tau,  k_i = (B_full/N)/cell is the local hydrostatic stiffness
    var fsd = [0, 0, 0, 0, 0, 0], wlist = sub.wl;
    if (wlist && wlist.length && P.freeSurface) {
      var ci = ((P.mass * P.g + P.trim) / this.hullPts.length) / this.hullCell * P.fsDampTau;
      var vwat = [0, 0, 0];
      for (i = 0; i < wlist.length; i++) {
        var pb = this.hullPts[wlist[i]];
        cross(w, pb, t3);
        var vpb = [v[0] + t3[0], v[1] + t3[1], v[2] + t3[2]];
        var vpw = mv(R, vpb, t3b);
        var wz = vpw[2];
        if (P.waves.length) { var pw = mv(R, pb, t3c); this.waterVelAcc(pos[0] + pw[0], pos[1] + pw[1], pos[2] + pw[2], t, vwat, null); wz -= vwat[2]; }
        var fwb = mtv(R, [0, 0, -ci * wz], t3d);
        var fx = fwb[0], fy = fwb[1], fz = fwb[2];
        var tq2 = cross(pb, [fx, fy, fz], t3c);
        fsd[0] += fx; fsd[1] += fy; fsd[2] += fz; fsd[3] += tq2[0]; fsd[4] += tq2[1]; fsd[5] += tq2[2];
      }
      for (i = 0; i < 6; i++) F[i] += fsd[i];
    }

    // ---- contact (penalty spring-damper + regularised Coulomb friction)
    var ct = [0, 0, 0, 0, 0, 0], cs = this.contactSpheres, Kc = P.contact.k, Cc = P.contact.c, MUc = P.contact.mu;
    var planes = this._planes;
    for (i = 0; i < cs.length; i++) {
      var sp = cs[i];
      mv(R, sp.p, t3);
      var cxw = pos[0] + t3[0], cyw = pos[1] + t3[1], czw = pos[2] + t3[2];
      for (var pl = 0; pl < planes.length; pl++) {
        var PL = planes[pl];
        var dist = PL.n[0] * cxw + PL.n[1] * cyw + PL.n[2] * czw - PL.d;
        var pen = sp.r - dist;
        if (pen <= 0) continue;
        // contact point (body) and its world velocity
        var nb = mtv(R, PL.n, t3b);
        var pcb = [sp.p[0] - nb[0] * sp.r, sp.p[1] - nb[1] * sp.r, sp.p[2] - nb[2] * sp.r];
        cross(w, pcb, t3c);
        var vcpb = [v[0] + t3c[0], v[1] + t3c[1], v[2] + t3c[2]];
        var vn = dot(vcpb, nb);
        var Fn = Kc * pen - Cc * vn; if (Fn < 0) Fn = 0;
        var vtx = vcpb[0] - vn * nb[0], vty = vcpb[1] - vn * nb[1], vtz = vcpb[2] - vn * nb[2];
        var vtm = Math.sqrt(vtx * vtx + vty * vty + vtz * vtz + 1e-4);
        var fr = -MUc * Fn / vtm;
        var fcb = [Fn * nb[0] + fr * vtx, Fn * nb[1] + fr * vty, Fn * nb[2] + fr * vtz];
        var tcb = cross(pcb, fcb, t3d);
        ct[0] += fcb[0]; ct[1] += fcb[1]; ct[2] += fcb[2]; ct[3] += tcb[0]; ct[4] += tcb[1]; ct[5] += tcb[2];
      }
    }
    for (i = 0; i < 6; i++) F[i] += ct[i];

    if (D) {
      D.thrust = tw; D.drag = drag; D.angDrag = angd; D.kutta = kut; D.magnus = mag; D.viscous = visc;
      D.coriolisA = cA; D.coriolisRB = crb; D.contact = ct; D.surfDamp = fsd; D.vrel = vr; D.vWaterBody = vcb;
    }
    return F;
  };

  Engine.prototype._updatePlanes = function () {
    var P = this.p, pl = [];
    if (P.mode === "pool") {
      pl.push({ n: [0, 0, -1], d: -P.floorZ });         // floor: -z >= -floorZ
      pl.push({ n: [-1, 0, 0], d: -P.half }); pl.push({ n: [1, 0, 0], d: -P.half });
      pl.push({ n: [0, -1, 0], d: -P.half }); pl.push({ n: [0, 1, 0], d: -P.half });
    } else {
      pl.push({ n: [0, 0, -1], d: -P.seabedZ });
    }
    this._planes = pl;
  };

  // thr: [{T: commanded thrust N (after ESC lag), kq: signed reaction-torque ratio}]
  Engine.prototype.step = function (dt, thr) {
    if (!(dt > 0)) return;
    var n = Math.max(1, Math.ceil(dt / this.p.hMax - 1e-9)), h = dt / n;
    for (var i = 0; i < n; i++) this._substep(h, thr, i === n - 1);
  };

  Engine.prototype._substep = function (h, thr, record) {
    var P = this.p, nu = this.nu, F = this._F, Fv0 = this._Fv0, A = this._A, i, k;
    quatToMat(this.q, this.R);
    this._updatePlanes();
    this._computeSubmergence();
    this._buildMass();
    var D = record ? {} : null;
    this._velocityForces(nu, thr, Fv0, D);
    for (i = 0; i < 6; i++) F[i] = Fv0[i];
    this._positionForces(F, D);
    for (i = 0; i < 36; i++) A[i] = this.M[i];
    if (P.implicit) {
      // numerical Jacobian of velocity-dependent forces: A = M - h dF/dnu
      var nu2 = this._nu2, Fvk = this._Fvk;
      for (k = 0; k < 6; k++) {
        for (i = 0; i < 6; i++) nu2[i] = nu[i];
        var eps = 1e-5 + 1e-4 * Math.abs(nu[k]);
        nu2[k] += eps;
        this._velocityForces(nu2, thr, Fvk, null);
        for (i = 0; i < 6; i++) A[i * 6 + k] -= h * (Fvk[i] - Fv0[i]) / eps;
      }
    }
    var b = [h * F[0], h * F[1], h * F[2], h * F[3], h * F[4], h * F[5]];
    if (!solveDense(A, b, 6)) b = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < 6; i++) {
      nu[i] += b[i];
      if (!isFinite(nu[i])) nu[i] = 0;
    }
    // safety limits
    for (i = 0; i < 3; i++) { nu[i] = Math.max(-25, Math.min(25, nu[i])); nu[3 + i] = Math.max(-40, Math.min(40, nu[3 + i])); }
    // kinematics: p_dot = R v ; q_dot = 1/2 q (x) [0, w]
    var R = this.R, v = [nu[0], nu[1], nu[2]], vw = mv(R, v, [0, 0, 0]);
    this.pos[0] += h * vw[0]; this.pos[1] += h * vw[1]; this.pos[2] += h * vw[2];
    var wx = nu[3], wy = nu[4], wz = nu[5], wn = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (wn > 1e-12) {
      var ha = 0.5 * wn * h, s = Math.sin(ha) / wn, c = Math.cos(ha);
      var dq = [c, wx * s, wy * s, wz * s], q = this.q;
      var nq = [
        q[0] * dq[0] - q[1] * dq[1] - q[2] * dq[2] - q[3] * dq[3],
        q[0] * dq[1] + q[1] * dq[0] + q[2] * dq[3] - q[3] * dq[2],
        q[0] * dq[2] - q[1] * dq[3] + q[2] * dq[0] + q[3] * dq[1],
        q[0] * dq[3] + q[1] * dq[2] - q[2] * dq[1] + q[3] * dq[0]
      ];
      var qn = Math.sqrt(nq[0] * nq[0] + nq[1] * nq[1] + nq[2] * nq[2] + nq[3] * nq[3]);
      this.q = [nq[0] / qn, nq[1] / qn, nq[2] / qn, nq[3] / qn];
    }
    this.t += h;
    if (D) {
      quatToMat(this.q, this.R);
      D.F = Array.prototype.slice.call(F);
      D.sub = this.sub.hull;
      D.massDiag = [this.M[0], this.M[7], this.M[14], this.M[21], this.M[28], this.M[35]];
      var spd = norm3(D.vrel), L = 2 * P.hull.r[0];
      D.speedThroughWater = spd;
      D.Re = spd * L * P.rho / P.mu;
      D.Fr = spd / Math.sqrt(P.g * L);
      this.diag = D;
    }
  };

  Engine.prototype.euler = function () { quatToMat(this.q, this.R); return matToEuler(this.R); };
  Engine.prototype.addedMassMatrix = function () { return Array.prototype.slice.call(this.MA); };

  return {
    Engine: Engine,
    ellipsoidProps: ellipsoidProps,
    tuckermanKappa: tuckermanKappa,
    projectedArea: projectedArea,
    sectionArea: sectionArea,
    quatToMat: quatToMat,
    eulerToQuat: eulerToQuat,
    matToEuler: matToEuler,
    COEF_AUV: COEF_AUV,
    COEF_MUJOCO: COEF_MUJOCO
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = HydroEngine;
