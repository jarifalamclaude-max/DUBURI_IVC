// Node unit tests for HydroEngine
const H = require("./hydro_engine.js");
let fails = 0;
function check(name, cond, info) {
  console.log((cond ? "PASS " : "FAIL ") + name + (info ? "  :: " + info : ""));
  if (!cond) fails++;
}
const f3 = a => "[" + a.map(x => (+x).toFixed(4)).join(", ") + "]";

// 1. Tuckerman kappa identities
{
  const k = H.tuckermanKappa([0.3, 0.3, 0.3]);
  check("sphere kappa = 2/3", k.every(x => Math.abs(x - 2 / 3) < 1e-5), f3(k));
  for (const r of [[0.4, 0.1, 0.1], [0.2, 0.05, 0.13], [1, 2, 3], [0.032, 0.042, 0.042]]) {
    const kk = H.tuckermanKappa(r), s = kk[0] + kk[1] + kk[2];
    check("kappa sum = 2 for " + JSON.stringify(r), Math.abs(s - 2) < 1e-4, f3(kk) + " sum=" + s.toFixed(6));
  }
  // prolate spheroid analytic (Lamb alpha0)
  const a = 0.405, b = 0.095, e = Math.sqrt(1 - (b / a) ** 2);
  const alpha0 = (2 * (1 - e * e) / e ** 3) * (0.5 * Math.log((1 + e) / (1 - e)) - e);
  const kp = H.tuckermanKappa([a, b, b]);
  check("prolate kappa_x = Lamb alpha0", Math.abs(kp[0] - alpha0) < 1e-4, kp[0].toFixed(5) + " vs " + alpha0.toFixed(5));
}
// 2. sphere added mass
{
  const P = H.ellipsoidProps([0.2, 0.2, 0.2]);
  check("sphere m_A = V/2", P.mA.every(m => Math.abs(m - P.V / 2) / (P.V / 2) < 1e-4), f3(P.mA) + " V/2=" + (P.V / 2).toFixed(5));
  check("sphere I_A = 0", P.IA.every(x => Math.abs(x) < 1e-12));
  const hull = H.ellipsoidProps([0.405, 0.095, 0.095]);
  console.log("  hull: V=" + hull.V.toFixed(5) + " m3, kappa=" + f3(hull.kappa) +
    " mA*rho=" + f3(hull.mA.map(x => x * 997)) + " kg, IA*rho=" + f3(hull.IA.map(x => x * 997)) + " kg m2");
  // Lamb prolate added-mass coefficients k1, k2 and k' for a/b=4.26
  const k1 = hull.kappa[0] / (2 - hull.kappa[0]), k2 = hull.kappa[1] / (2 - hull.kappa[1]);
  check("prolate k1 ~ 0.07, k2 ~ 0.87 (L/D~4.3)", k1 > 0.05 && k1 < 0.09 && k2 > 0.83 && k2 < 0.9, "k1=" + k1.toFixed(4) + " k2=" + k2.toFixed(4));
  const pod = H.ellipsoidProps([0.032, 0.042, 0.042]);
  console.log("  pod : V=" + pod.V.toExponential(3) + " mA*rho=" + f3(pod.mA.map(x => x * 997)) + " IA*rho=" + f3(pod.IA.map(x => x * 997)));
}
// 3. projected-area lemma vs brute-force silhouette area
{
  function bruteArea(r, u) {
    // project sampled surface points on plane normal to u; rasterise convex hull area via polar max radius
    const t = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    let n1 = Math.hypot(...e1); e1 = e1.map(x => x / n1);
    const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
    const NA = 720, rmax = new Float64Array(NA);
    for (let i = 0; i < 400; i++) for (let j = 0; j < 800; j++) {
      const th = Math.PI * (i + 0.5) / 400, ph = 2 * Math.PI * j / 800;
      const p = [r[0] * Math.sin(th) * Math.cos(ph), r[1] * Math.sin(th) * Math.sin(ph), r[2] * Math.cos(th)];
      const x = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], y = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
      const ang = Math.atan2(y, x), k = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * NA) % NA, rr = Math.hypot(x, y);
      if (rr > rmax[k]) rmax[k] = rr;
    }
    let A = 0; for (let k = 0; k < NA; k++) A += 0.5 * rmax[k] * rmax[k] * (2 * Math.PI / NA);
    return A;
  }
  for (const [r, u] of [[[0.405, 0.095, 0.095], [1, 0, 0]], [[0.405, 0.095, 0.095], [0.6, 0.8, 0]], [[0.3, 0.1, 0.05], [0.3, 0.5, Math.sqrt(1 - 0.34)]]]) {
    const a1 = H.projectedArea(r, u), a2 = bruteArea(r, u), as = H.sectionArea(r, u);
    const N = [r[1] * r[2] / r[0] * u[0], r[2] * r[0] / r[1] * u[1], r[0] * r[1] / r[2] * u[2]], nN = Math.hypot(...N);
    const cosA = (N[0] * u[0] + N[1] * u[1] + N[2] * u[2]) / nN;
    check("exact A_proj vs brute " + JSON.stringify(r) + " u=" + f3(u), Math.abs(a1 - a2) / a2 < 0.01, a1.toFixed(5) + " vs brute " + a2.toFixed(5) + " | MuJoCo-lemma " + as.toFixed(5));
    check("MuJoCo lemma = A_proj / cos(alpha)", Math.abs(as * cosA - a1) / a1 < 1e-9, (as * cosA).toFixed(6) + " vs " + a1.toFixed(6));
  }
}

const PRESET = [
  { pos: [-0.18, -0.17, 0.00], azim: 0, elev: 0, prop: "CW" },
  { pos: [-0.18, 0.17, 0.00], azim: 0, elev: 0, prop: "CCW" },
  { pos: [0.00, -0.17, 0.00], azim: 0, elev: 90, prop: "CW" },
  { pos: [0.00, 0.17, 0.00], azim: 0, elev: 90, prop: "CCW" },
  { pos: [0.00, 0.00, 0.14], azim: 90, elev: 0, prop: "CW" }
];
function dirOf(t) { const a = t.azim * Math.PI / 180, e = t.elev * Math.PI / 180; return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)]; }
function mkEngine(opts) {
  const E = new H.Engine(opts || {});
  E.setThrusters(PRESET.map(t => ({ pos: t.pos, dir: dirOf(t) })));
  E.setPose(0, 0, 0, 0, 0, 0);
  return E;
}
function thrusts(T) { return T.map((x, i) => ({ T: x, kq: (PRESET[i].prop === "CW" ? -1 : 1) * 0.015 })); }
function run(E, secs, T, dt = 1 / 60, cb) { const n = Math.round(secs / dt); for (let i = 0; i < n; i++) { E.step(dt, thrusts(typeof T === "function" ? T(E, i * dt) : T)); if (cb) cb(E, i * dt); } }

// 4. neutral equilibrium
{
  const E = mkEngine({ trim: 0 });
  run(E, 10, [0, 0, 0, 0, 0]);
  const d = Math.hypot(...E.pos), eu = E.euler();
  check("neutral vehicle stays put (10 s)", d < 2e-3 && Math.abs(eu.roll) < 1e-3 && Math.abs(eu.pitch) < 1e-3, "drift=" + d.toExponential(2) + " m");
  const M = E.M; console.log("  total mass diag: " + f3([M[0], M[7], M[14], M[21], M[28], M[35]]));
}
// 5. positive trim -> slow rise
{
  const E = mkEngine({ trim: 0.6 });
  run(E, 12, [0, 0, 0, 0, 0]);
  const w = E.nu[2];
  check("trim +0.6 N rises at ~0.1 m/s", w < -0.05 && w > -0.16, "w=" + w.toFixed(4) + " m/s (neg = up), z=" + E.pos[2].toFixed(3));
}
// 6. surge terminal speed and straightness
{
  const E = mkEngine({ trim: 0, mode: "ocean" });
  run(E, 20, [34, 34, 0, 0, 0]);
  const u = E.nu[0], eu = E.euler();
  check("68 N surge -> ~1.3-1.6 m/s", u > 1.2 && u < 1.7, "u=" + u.toFixed(3) + " yaw=" + (eu.yaw * 57.3).toFixed(2) + " pitch=" + (eu.pitch * 57.3).toFixed(2));
  console.log("  diag: Re=" + E.diag.Re.toExponential(2) + " Fr=" + E.diag.Fr.toFixed(3) + " drag=" + f3(E.diag.drag) +
    " thr=" + E.thrOut.slice(0, 2).map(o => o.T.toFixed(1) + "N J=" + o.J.toFixed(2) + " rpm=" + o.rpm.toFixed(0)).join(" | "));
  const eu2 = E.euler(); console.log("  steady surge pitch=" + (eu2.pitch * 57.3).toFixed(2) + " deg, depth change=" + E.pos[2].toFixed(2) + " m");
  const E2 = mkEngine({ trim: 0, propKT: false, mode: "ocean" }); run(E2, 20, [34, 34, 0, 0, 0]);
  console.log("  without K_T(J) loss: u=" + E2.nu[0].toFixed(3));
}
// 7. Munk-moment yaw instability of a finless hull (small perturbation grows)
{
  const E = mkEngine({ trim: 0, mode: "ocean" });
  run(E, 6, [34, 34, 0, 0, 0]);
  E.nu[5] += 0.02;
  const y0 = E.euler().yaw;
  run(E, 6, [34, 34, 0, 0, 0]);
  const y1 = E.euler().yaw;
  console.log("  yaw after perturbation: " + (y0 * 57.3).toFixed(2) + " -> " + (y1 * 57.3).toFixed(2) + " deg  (r=" + E.nu[5].toFixed(3) + ")");
}
// 8. free decay of energy: no thrust, initial velocities
{
  const E = mkEngine({ trim: 0, hydrostatic: true, mode: "ocean" });
  E.nu.set([1.2, 0.4, -0.3, 0.8, 0.5, 1.0]);
  let prevKE = Infinity, mono = true, maxRise = 0;
  run(E, 8, [0, 0, 0, 0, 0], 1 / 60, (e) => {
    const n = e.nu, KE = 0.5 * (e.M[0] * n[0] ** 2 + e.M[7] * n[1] ** 2 + e.M[14] * n[2] ** 2) + 0.5 * (e.M[21] * n[3] ** 2 + e.M[28] * n[4] ** 2 + e.M[35] * n[5] ** 2);
    if (KE > prevKE + 1e-3) { mono = false; maxRise = Math.max(maxRise, KE - prevKE); }
    prevKE = KE;
  });
  const sp = Math.hypot(E.nu[0], E.nu[1], E.nu[2]);
  check("coasting decays without blow-up", isFinite(sp) && sp < 0.25, "speed after 8 s=" + sp.toFixed(3) + " m/s, KE monotone(approx)=" + mono + " maxRise=" + maxRise.toExponential(2));
}
// 9. roll restoring oscillation
{
  const E = mkEngine({ trim: 0 });
  E.setPose(0, 0, 0, 30 * Math.PI / 180, 0, 0);
  let crossings = [], prev = E.euler().roll, tPrev = 0;
  run(E, 6, [0, 0, 0, 0, 0], 1 / 240, (e, t) => { const r = e.euler().roll; if (prev > 0 && r <= 0) crossings.push(t); prev = r; });
  const per = crossings.length > 1 ? (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) : NaN;
  const Ixx = E.M[21], W = 12 * 9.81, Tth = 2 * Math.PI * Math.sqrt(Ixx / (W * 0.05));
  check("roll period ~ 2pi sqrt(I/(W BG))", Math.abs(per - Tth) / Tth < 0.2, "measured " + per.toFixed(3) + " s, small-angle theory " + Tth.toFixed(3) + " s, final roll " + (E.euler().roll * 57.3).toFixed(2) + " deg");
}
// 10. surfacing with strong positive trim -> floats with partial emergence
{
  const E = mkEngine({ trim: 10 });
  const hist = [];
  run(E, 90, [0, 0, 0, 0, 0], 1 / 60, (e, t) => { if (Math.abs(t % 10) < 1e-6 || Math.abs(t % 10 - 10) < 0.008) hist.push(t.toFixed(0) + ":" + e.pos[2].toFixed(3) + "/" + e.sub.hull.toFixed(3)); });
  console.log("  float history z/f: " + hist.join("  "));
  const f = E.sub.hull, expect = (12 * 9.81) / (12 * 9.81 + 10);
  check("floats at surface with f_sub ~ W/(W+trim)", Math.abs(f - expect) < 0.01 && Math.abs(E.nu[2]) < 0.02, "f=" + f.toFixed(4) + " expect " + expect.toFixed(4) + " z=" + E.pos[2].toFixed(3) + " (surface -2.5)");
}
// 11. sinks to the floor and rests
{
  const E = mkEngine({ trim: -10 });
  run(E, 40, [0, 0, 0, 0, 0]);
  // lowest point is the T5 pod (z=+0.14, r=0.045) -> CG rests 0.185 m above the floor
  check("negative trim rests on pool floor (on T5 pod)", Math.abs(E.pos[2] - (5.5 - 0.185)) < 0.01 && Math.abs(E.nu[2]) < 0.01, "z=" + E.pos[2].toFixed(4) + " expected ~" + (5.5 - 0.185).toFixed(3) + " pitch=" + (E.euler().pitch * 57.3).toFixed(1));
}
// 12. current drift
{
  const E = mkEngine({ trim: 0, current: [0.5, 0, 0], mode: "ocean" });
  run(E, 40, [0, 0, 0, 0, 0]);
  const vw = E.R[0] * E.nu[0] + E.R[1] * E.nu[1] + E.R[2] * E.nu[2];
  check("vehicle drifts with 0.5 m/s current", Math.abs(vw - 0.5) < 0.05, "v_north=" + vw.toFixed(3));
}
// 13. waves in ocean mode near surface
{
  const g = 9.81, waves = [];
  [[2 * Math.PI / 16, 0, 0.25, 0], [2 * Math.PI / 10 * 0.8, 2 * Math.PI / 10 * 0.6, 0.12, 1.3]].forEach(([kx, ky, a, ph]) => {
    const k = Math.hypot(kx, ky); waves.push({ kx, ky, a, omega: Math.sqrt(g * k), phase: ph });
  });
  const E = mkEngine({ trim: 2, mode: "ocean", waves });
  let ok = true, minZ = 1e9, maxZ = -1e9, maxRoll = 0;
  run(E, 30, [0, 0, 0, 0, 0], 1 / 60, (e, t) => { if (!E.pos.every(isFinite)) ok = false; if (t > 15) { minZ = Math.min(minZ, e.pos[2]); maxZ = Math.max(maxZ, e.pos[2]); maxRoll = Math.max(maxRoll, Math.abs(e.euler().roll)); } });
  check("ocean waves: floating vehicle heaves with the sea", ok && (maxZ - minZ) > 0.15, "heave range=" + (maxZ - minZ).toFixed(3) + " m, max roll=" + (maxRoll * 57.3).toFixed(1) + " deg");
}
// 14. inertia-box model and explicit integrator sanity
{
  const E = mkEngine({ trim: 0, model: "inertia", mode: "ocean" });
  run(E, 20, [34, 34, 0, 0, 0]);
  check("inertia-box model surge speed sane", E.nu[0] > 1.0 && E.nu[0] < 2.0, "u=" + E.nu[0].toFixed(3));
  const E2 = mkEngine({ trim: 0, implicit: false, mode: "ocean" });
  run(E2, 20, [34, 34, 0, 0, 0]);
  const E3 = mkEngine({ trim: 0, implicit: true, mode: "ocean" });
  run(E3, 20, [34, 34, 0, 0, 0]);
  check("explicit vs implicit agree at steady state", Math.abs(E2.nu[0] - E3.nu[0]) < 0.01, E2.nu[0].toFixed(4) + " vs " + E3.nu[0].toFixed(4));
}
// 15. MuJoCo default coefficients run & lateral / yaw responses
{
  const E = mkEngine({ trim: 0, mode: "ocean" }); E.setCoefPreset("mujoco");
  run(E, 20, [34, 34, 0, 0, 0]);
  console.log("  MuJoCo-default coef surge speed: " + E.nu[0].toFixed(3));
  const E2 = mkEngine({ trim: 0, mode: "ocean" });
  run(E2, 15, [0, 0, -15.65, 15.65, 38]);
  console.log("  38 N lateral (T5, roll-compensated by T3/T4): v=" + E2.nu[1].toFixed(3) + " roll=" + (E2.euler().roll * 57.3).toFixed(2) + " deg");
  const E3 = mkEngine({ trim: 0, mode: "ocean" });
  run(E3, 10, [-32, 32, 0, 0, 0]);
  console.log("  yaw couple 32N*0.34m: r=" + E3.nu[5].toFixed(3) + " rad/s");
  const E4 = mkEngine({ trim: 0, mode: "ocean" });
  run(E4, 10, [0, 0, 31, 31, 0]);
  console.log("  62 N heave down: w=" + E4.nu[2].toFixed(3));
}
// 16. performance
{
  const E = mkEngine({ trim: 0.6 });
  const t0 = process.hrtime.bigint();
  run(E, 30, [20, 25, 10, -10, 15]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("  perf: 30 s sim (" + Math.round(30 * 240) + " implicit substeps) in " + ms.toFixed(0) + " ms -> " + (ms / (30 * 60)).toFixed(3) + " ms/frame");
}
console.log(fails ? ("\n" + fails + " FAILED") : "\nALL PASSED");
process.exit(fails ? 1 : 0);
