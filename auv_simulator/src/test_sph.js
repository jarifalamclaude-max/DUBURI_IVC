const S = require("./sph_engine.js");
let fails = 0;
const check = (n, c, i) => { console.log((c ? "PASS " : "FAIL ") + n + (i ? "  :: " + i : "")); if (!c) fails++; };
const rho = 1000, A = Math.PI * 0.038 * 0.038;
function jet(T, x, y, z, dx, dy, dz) { const vj = Math.sqrt(2 * Math.abs(T) / (rho * A)); return { x, y, z, dx, dy, dz, vj, vbx: 0, vby: 0, vbz: 0, radius: 0.038, thrust: T }; }

// 1. steady horizontal jet in open water
{
  const s = new S.SPH({ maxN: 3000 }); s.bounds.mode = "ocean"; s.bounds.surfY = 50; s.bounds.seabedY = -50;
  const J = jet(34, 0, 0, 0, 1, 0, 0);
  let tot = 0, nanFree = true, msSum = 0, frames = 0;
  for (let f = 0; f < 240; f++) { s.emitJet(0, J, 1 / 60); s.step(1 / 60); if (f > 120) { msSum += s.stats.ms; frames++; }
    for (let i = 0; i < s.n; i++) if (!isFinite(s.px[i] + s.vx[i])) nanFree = false; }
  // centreline velocity vs distance
  const bins = {}; for (let i = 0; i < s.n; i++) { const b = Math.floor(s.px[i] / 0.25); (bins[b] = bins[b] || []).push(s.vx[i]); }
  const prof = Object.keys(bins).map(Number).sort((a, b) => a - b).map(b => (b * 0.25 + 0.125).toFixed(2) + "m:" + (bins[b].reduce((a, c) => a + c, 0) / bins[b].length).toFixed(2));
  let maxX = 0, maxR = 0; for (let i = 0; i < s.n; i++) { maxX = Math.max(maxX, s.px[i]); maxR = Math.max(maxR, Math.hypot(s.py[i], s.pz[i])); }
  console.log("  vj=" + J.vj.toFixed(2) + " m/s, n=" + s.n + ", reach=" + maxX.toFixed(2) + " m, spread r=" + maxR.toFixed(2) + " m");
  console.log("  mean u(x): " + prof.join("  "));
  console.log("  rho mean/max=" + s.stats.rhoMean.toFixed(0) + "/" + s.stats.rhoMax.toFixed(0) + " nb=" + s.stats.nbMean.toFixed(1) + " edge=" + s.stats.edge + " substeps=" + s.stats.substeps);
  check("steady jet finite & bounded", nanFree && s.n > 300 && maxX > 1.0 && maxX < 4.5, "n=" + s.n);
  check("jet decays downstream (entrainment)", bins[1] && bins[6] && (bins[6].reduce((a,c)=>a+c,0)/bins[6].length) < 0.6 * (bins[1].reduce((a,c)=>a+c,0)/bins[1].length));
  console.log("  perf: " + (msSum / frames).toFixed(2) + " ms/frame for n~" + s.n);
}
// 2. vertical jet impinging on the pool floor -> radial wall jet, pressure active
{
  const s = new S.SPH({ maxN: 3000 });
  const J = jet(40, 0, -5.2, 0, 0, -1, 0);
  for (let f = 0; f < 150; f++) { s.emitJet(0, J, 1 / 60); s.step(1 / 60); }
  let nearFloor = 0, radialOut = 0, rmax = 0;
  for (let i = 0; i < s.n; i++) if (s.py[i] < -5.4) { nearFloor++; const r = Math.hypot(s.px[i], s.pz[i]); rmax = Math.max(rmax, r); if (r > 0.1 && (s.px[i] * s.vx[i] + s.pz[i] * s.vz[i]) / r > 0.05) radialOut++; }
  console.log("  floor jet: n=" + s.n + " nearFloor=" + nearFloor + " radialOut=" + radialOut + " spread=" + rmax.toFixed(2) + " m, rhoMax=" + s.stats.rhoMax.toFixed(0));
  check("floor impingement spreads radially (wall jet)", radialOut > 0.4 * nearFloor && rmax > 0.3);
  check("pressure engages under compression", s.stats.rhoMax > 1000);
}
// 3. jet hitting a fixed hull -> impulse on hull along jet direction
{
  const s = new S.SPH({ maxN: 3000 }); s.bounds.mode = "ocean"; s.bounds.surfY = 50; s.bounds.seabedY = -50;
  s.hull = { c: [0.6, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], r: [0.095, 0.405, 0.095], v: [0, 0, 0], w: [0, 0, 0], cg: [0.6, 0, 0] };
  const J = jet(30, 0, 0, 0, 1, 0, 0);
  let Fx = 0, nF = 0;
  for (let f = 0; f < 180; f++) { s.emitJet(0, J, 1 / 60); s.step(1 / 60); if (f > 90) { Fx += s.hullImpulse[0] * 60; nF++; } }
  Fx /= nF;
  console.log("  impinging jet force on hull: Fx=" + Fx.toFixed(2) + " N (thrust 30 N, full stop would be ~30 N)");
  check("jet impingement pushes hull downstream", Fx > 3 && Fx < 45);
}
// 4. velocity sampling for snow advection
{
  const s = new S.SPH({ maxN: 3000 }); s.bounds.mode = "ocean"; s.bounds.surfY = 50; s.bounds.seabedY = -50;
  const J = jet(34, 0, 0, 0, 1, 0, 0);
  for (let f = 0; f < 60; f++) { s.emitJet(0, J, 1 / 60); s.step(1 / 60); }
  s.prepareSampling(); const o = [0, 0, 0];
  const w1 = s.sampleVelocity(0.3, 0, 0, o), u1 = o[0];
  const w2 = s.sampleVelocity(0.3, 1.0, 0, o);
  check("sampling inside jet returns jet velocity", w1 > 0.1 && u1 > 1, "w=" + w1.toFixed(2) + " u=" + u1.toFixed(2));
  check("sampling far outside jet returns 0 coverage", w2 === 0);
}
console.log(fails ? fails + " FAILED" : "ALL PASSED");
