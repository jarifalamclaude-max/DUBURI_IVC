// =========================================================================
// WATER FX — physically-motivated underwater rendering pipeline (three r128)
//  1. ripple-tank heightfield (wave equation) for the pool surface
//  2. area-ratio caustics: refract sunlight through the rippled surface onto
//     a focal plane, intensity = (old area / new area)  -> tileable texture
//  3. opaque scene -> HDR target + depth texture (materials get caustics and
//     Beer-Lambert per-channel absorption injected)
//  4. screen-space SPH fluid: sphere-depth splats, bilateral smoothing,
//     thickness accumulation (surface reconstruction for the SPH particles)
//  5. single-scattering volumetric light (god rays) with HG phase function,
//     caustic-modulated sun columns, Beer-Lambert extinction (half res)
//  6. composite: analytic free surface (Snell's window + total internal
//     reflection from below, Fresnel reflect/refract from above), fluid
//     shading (refraction, Fresnel, absorption), writes depth
//  7. transparent pass, 8. bloom, 9. ACES filmic + FXAA to screen
// =========================================================================
function createWaterFX(renderer, scene, camera, cfg) {
  "use strict";
  var FX = { enabled: false, reason: "" };
  if (!renderer.capabilities.isWebGL2) { FX.reason = "WebGL2 not available"; return FX; }
  if (!renderer.extensions.get("EXT_color_buffer_float")) { FX.reason = "EXT_color_buffer_float not available"; return FX; }
  FX.enabled = true;

  var POOL_HALF = cfg.poolHalf, TILE = 4.0, WAVE_N = 256, CAUSTIC_N = 1024;
  var Q = { volFull: true, fluidFull: true, volSteps: 32 };   // UHD by default
  var HF = THREE.HalfFloatType;
  function makeRT(w, h, o) {
    var r = new THREE.WebGLRenderTarget(w, h, Object.assign({
      type: HF, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false
    }, o || {}));
    r.texture.generateMipmaps = false;
    return r;
  }

  // ---------------------------------------------------------- full-screen
  var fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var fsScene = new THREE.Scene();
  var fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  fsQuad.frustumCulled = false;
  fsScene.add(fsQuad);
  var FS_VERT = "varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
  function pass(mat, target) {
    fsQuad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }

  // ------------------------------------------------------ shared GLSL code
  var RIPPLE_GLSL = [
    "uniform float uTime; uniform float uTile; uniform float uRippleAmp;",
    "vec2 rippleSlope(vec2 p, float t){",
    "  vec2 s = vec2(0.0); vec2 k; float w; float ph;",
    "  k = 6.2831853*vec2(5.0,2.0)/uTile;   w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t;       s -= 0.0034*k*sin(ph);",
    "  k = 6.2831853*vec2(-3.0,6.0)/uTile;  w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t + 1.7; s -= 0.0030*k*sin(ph);",
    "  k = 6.2831853*vec2(7.0,-4.0)/uTile;  w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t + 4.1; s -= 0.0024*k*sin(ph);",
    "  k = 6.2831853*vec2(2.0,-9.0)/uTile;  w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t + 2.3; s -= 0.0019*k*sin(ph);",
    "  k = 6.2831853*vec2(-8.0,-3.0)/uTile; w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t + 5.5; s -= 0.0021*k*sin(ph);",
    "  k = 6.2831853*vec2(11.0,5.0)/uTile;  w = sqrt(9.81*length(k)); ph = dot(k,p) - w*t + 0.9; s -= 0.0012*k*sin(ph);",
    "  return s * uRippleAmp;",
    "}"
  ].join("\n");

  // ------------------------------------------------- 0. sun shadow map
  var SHADOW_N = 2048, SHADOW_S = 3.6;
  var shadowRT = new THREE.WebGLRenderTarget(SHADOW_N, SHADOW_N, { depthBuffer: true, stencilBuffer: false });
  shadowRT.texture.generateMipmaps = false;
  shadowRT.depthTexture = new THREE.DepthTexture(SHADOW_N, SHADOW_N);
  shadowRT.depthTexture.type = THREE.UnsignedIntType;
  shadowRT.depthTexture.format = THREE.DepthFormat;
  shadowRT.depthTexture.minFilter = shadowRT.depthTexture.magFilter = THREE.NearestFilter;
  var shadowCam = new THREE.OrthographicCamera(-SHADOW_S, SHADOW_S, SHADOW_S, -SHADOW_S, 0.1, 45);
  shadowCam.layers.set(2);
  var shadowMat4 = new THREE.Matrix4(), depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  var shadowOnU = { value: 0 }, shadowMatU = { value: shadowMat4 }, shadowTexU = { value: shadowRT.depthTexture };
  var shadowTexelU = { value: 1 / SHADOW_N };
  var _sr = new THREE.Vector3(), _su = new THREE.Vector3();
  function renderShadow(target, sunDir) {
    shadowCam.up.set(1, 0, 0);
    shadowCam.position.copy(target).addScaledVector(sunDir, -22);
    shadowCam.lookAt(target);
    shadowCam.updateMatrixWorld();
    // snap to the shadow texel grid (no edge crawling while the AUV moves)
    var e = shadowCam.matrixWorld.elements, texel = 2 * SHADOW_S / SHADOW_N;
    _sr.set(e[0], e[1], e[2]); _su.set(e[4], e[5], e[6]);
    var dx = target.dot(_sr), dy = target.dot(_su);
    shadowCam.position.addScaledVector(_sr, Math.round(dx / texel) * texel - dx).addScaledVector(_su, Math.round(dy / texel) * texel - dy);
    shadowCam.updateMatrixWorld();
    shadowCam.updateProjectionMatrix();
    shadowMat4.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
    var bg = scene.background; scene.background = null;
    scene.overrideMaterial = depthOnly;
    renderer.setRenderTarget(shadowRT); renderer.clear();
    renderer.render(scene, shadowCam);
    scene.overrideMaterial = null; scene.background = bg;
  }
  var SHADOW_GLSL = [
    "uniform sampler2D tShadow; uniform mat4 uShadowMat; uniform float uShadowOn; uniform float uShadowTexel;",
    "const vec2 SPD[12] = vec2[12](vec2(-0.326,-0.406), vec2(-0.840,-0.074), vec2(-0.696,0.457), vec2(-0.203,0.621), vec2(0.962,-0.195), vec2(0.473,-0.480),",
    "  vec2(0.519,0.767), vec2(0.185,-0.893), vec2(0.507,0.064), vec2(0.896,0.412), vec2(-0.322,-0.933), vec2(-0.792,-0.598));",
    "float sunShadow(vec3 wp, float radius, int taps){",
    "  if (uShadowOn < 0.5) return 1.0;",
    "  vec4 lp = uShadowMat * vec4(wp, 1.0); vec3 nd = lp.xyz / lp.w; vec2 uv = nd.xy * 0.5 + 0.5;",
    "  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) return 1.0;",
    "  float z = nd.z * 0.5 + 0.5 - 0.0004; float lit = 0.0;",
    "  for (int i = 0; i < 12; i++) { if (i >= taps) break; lit += z <= texture2D(tShadow, uv + SPD[i] * uShadowTexel * radius).r ? 1.0 : 0.0; }",
    "  float edge = smoothstep(0.0, 0.08, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));",
    "  return mix(1.0, lit / float(taps), edge);",
    "}"
  ].join("\n");
  FX.shadowUniforms = { tShadow: shadowTexU, uShadowMat: shadowMatU, uShadowOn: shadowOnU, uShadowTexel: shadowTexelU };
  FX.SHADOW_GLSL = SHADOW_GLSL;

  // ------------------------------------------------------- 1. wave sim
  var waveA = makeRT(WAVE_N, WAVE_N), waveB = makeRT(WAVE_N, WAVE_N);
  var drops = [];
  for (var i = 0; i < 16; i++) drops.push(new THREE.Vector4());
  var waveMat = new THREE.ShaderMaterial({
    uniforms: {
      tPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / WAVE_N, 1 / WAVE_N) },
      uK: { value: 0.1 }, uDamp: { value: 0.996 }, uCell: { value: 2 * POOL_HALF / WAVE_N },
      uDrops: { value: drops }, uNDrops: { value: 0 }
    },
    vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tPrev; uniform vec2 uTexel; uniform float uK; uniform float uDamp; uniform float uCell;",
      "uniform vec4 uDrops[16]; uniform int uNDrops; varying vec2 vUv;",
      "void main(){",
      "  vec4 c = texture2D(tPrev, vUv);",
      "  float hL = texture2D(tPrev, vUv - vec2(uTexel.x, 0.0)).r, hR = texture2D(tPrev, vUv + vec2(uTexel.x, 0.0)).r;",
      "  float hD = texture2D(tPrev, vUv - vec2(0.0, uTexel.y)).r, hU = texture2D(tPrev, vUv + vec2(0.0, uTexel.y)).r;",
      "  float avg = 0.25 * (hL + hR + hD + hU);",
      "  float v = (c.g + (avg - c.r) * 2.0 * uK) * uDamp;",
      "  float h = (c.r + v) * 0.9995;",
      "  for (int i = 0; i < 16; i++) { if (i >= uNDrops) break; vec2 d = (vUv - uDrops[i].xy) / uDrops[i].z; h += uDrops[i].w * exp(-dot(d, d) * 2.0); }",
      "  vec2 slope = vec2(hR - hL, hU - hD) / (2.0 * uCell);",
      "  gl_FragColor = vec4(h, v, slope);",
      "}"
    ].join("\n"),
    depthTest: false, depthWrite: false
  });
  function clearWaves() {
    renderer.setRenderTarget(waveA); renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.setRenderTarget(waveB); renderer.clear();
  }

  // ---------------------------------------------------- 2. caustics tile
  var rtCaustic = null, cGeo = null;
  function makeCausticTarget(N) {
    var t = makeRT(N, N, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
    t.texture.generateMipmaps = true;
    t.texture.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }
  function makeCausticGeometry(seg) {
    var bg = new THREE.PlaneGeometry(1, 1, seg, seg), g = new THREE.InstancedBufferGeometry();
    g.setIndex(bg.index);
    g.setAttribute("position", bg.getAttribute("position"));
    var o = new Float32Array(18), k = 0;
    for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) { o[k++] = a; o[k++] = b; }
    g.setAttribute("aOffset", new THREE.InstancedBufferAttribute(o, 2));
    g.instanceCount = 9;
    return g;
  }
  rtCaustic = makeCausticTarget(CAUSTIC_N);
  cGeo = makeCausticGeometry(256);
  var causticDirty = true;
  var sunAirU = { value: new THREE.Vector3(-0.3, -0.85, -0.4).normalize() };
  var timeU = { value: 0 }, rippleU = { value: 1 };
  var causticMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uTile: { value: TILE }, uRippleAmp: rippleU, uDepth: { value: 8.0 }, uSunAir: sunAirU },
    vertexShader: RIPPLE_GLSL + "\n" + [
      "uniform float uDepth; uniform vec3 uSunAir; attribute vec2 aOffset;",
      "varying vec3 vOld; varying vec3 vNew;",
      "void main(){",
      "  vec2 p = (position.xy + 0.5 + aOffset) * uTile;",
      "  vec2 s = rippleSlope(p, uTime);",
      "  vec3 n = normalize(vec3(-s.x, 1.0, -s.y));",
      "  vec3 rf = refract(uSunAir, vec3(0.0, 1.0, 0.0), 0.7502);",
      "  vec3 r = refract(uSunAir, n, 0.7502);",
      "  vec3 P = vec3(p.x, 0.0, p.y);",
      "  vOld = P + rf * (uDepth / -rf.y);",
      "  vNew = P + r * (uDepth / -min(r.y, -0.05));",
      "  vec2 sh = rf.xz * (uDepth / -rf.y);",
      "  vec2 q = (vNew.xz - sh) / uTile;",
      "  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);",
      "}"
    ].join("\n"),
    fragmentShader: [
      "varying vec3 vOld; varying vec3 vNew;",
      "void main(){",
      "  float oldA = length(dFdx(vOld)) * length(dFdy(vOld));",
      "  float newA = length(dFdx(vNew)) * length(dFdy(vNew));",
      "  gl_FragColor = vec4(vec3(0.2 * oldA / max(newA, 1e-9)), 1.0);",
      "}"
    ].join("\n"),
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, extensions: { derivatives: true }
  });
  var causticScene = new THREE.Scene();
  var causticMesh = new THREE.Mesh(cGeo, causticMat);
  causticMesh.frustumCulled = false;
  causticScene.add(causticMesh);

  // ------------------------------------------ 3. scene + transparent target
  var W = 2, H = 2, rtScene, rtHDR, rtVol, rtFD, rtFB, rtFT, bloomRT = [];
  function allocTargets(w, h) {
    [rtScene, rtHDR, rtVol, rtFD, rtFB, rtFT].forEach(function (t) { if (t) t.dispose(); });
    bloomRT.forEach(function (t) { t.dispose(); });
    W = w; H = h;
    rtScene = makeRT(w, h, { depthBuffer: true });
    rtScene.depthTexture = new THREE.DepthTexture(w, h);
    rtScene.depthTexture.type = THREE.UnsignedIntType;
    rtScene.depthTexture.format = THREE.DepthFormat;
    rtScene.depthTexture.minFilter = rtScene.depthTexture.magFilter = THREE.NearestFilter;
    rtHDR = makeRT(w, h, { depthBuffer: true });
    var hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    var vw = Q.volFull ? w : hw, vh = Q.volFull ? h : hh, fw = Q.fluidFull ? w : hw, fh = Q.fluidFull ? h : hh;
    rtVol = makeRT(vw, vh);
    rtFD = makeRT(fw, fh, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    rtFB = makeRT(fw, fh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    rtFT = makeRT(fw, fh);
    bloomRT = [];
    var bw = hw, bh = hh;
    for (var k = 0; k < 5; k++) { bloomRT.push(makeRT(Math.max(1, bw), Math.max(1, bh))); bw >>= 1; bh >>= 1; }
    compU.tScene.value = rtScene.texture; compU.tDepth.value = rtScene.depthTexture;
    compU.tVol.value = rtVol.texture; compU.tFluid.value = rtFD.texture; compU.tThick.value = rtFT.texture;
    compU.uRes.value.set(w, h); compU.uHalfTexel.value.set(1 / fw, 1 / fh); compU.uVolTexel.value.set(1 / vw, 1 / vh);
    volU.tDepth.value = rtScene.depthTexture;
    blurU.uTexel.value.set(1 / fw, 1 / fh);
    blurU.uScale.value = Q.fluidFull ? 2.0 : 1.0;
    finalU.tHDR.value = rtHDR.texture; finalU.tBloom.value = bloomRT[0].texture; finalU.uTexel.value.set(1 / w, 1 / h);
  }

  // --------------------------------------------------- 4. SPH fluid splats
  var MAXP = cfg.maxParticles || 4000;
  var quad = new THREE.BufferGeometry();
  quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  var fGeo = new THREE.InstancedBufferGeometry();
  fGeo.setIndex(quad.index);
  fGeo.setAttribute("position", quad.getAttribute("position"));
  var aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3);
  var aData = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 4), 4);
  aPos.setUsage(THREE.DynamicDrawUsage); aData.setUsage(THREE.DynamicDrawUsage);
  fGeo.setAttribute("aPos", aPos); fGeo.setAttribute("aData", aData);
  fGeo.instanceCount = 0;
  var radiusU = { value: 0.036 };
  var SPLAT_VERT = [
    "attribute vec3 aPos; attribute vec4 aData; uniform float uRadius;",
    "varying vec2 vCorner; varying float vRad; varying vec3 vCV; varying float vAlpha; varying float vSpeed;",
    "void main(){",
    "  vec4 cv = viewMatrix * vec4(aPos, 1.0);",
    "  float r = uRadius * aData.x;",
    "  vCorner = position.xy; vRad = r; vCV = cv.xyz; vAlpha = aData.y; vSpeed = aData.z;",
    "  gl_Position = projectionMatrix * vec4(cv.xyz + vec3(position.xy * r, 0.0), 1.0);",
    "}"
  ].join("\n");
  var projU = { value: new THREE.Matrix4() };
  var fluidDepthMat = new THREE.ShaderMaterial({
    uniforms: { uRadius: radiusU, uProjM: projU },
    vertexShader: SPLAT_VERT,
    fragmentShader: [
      "uniform mat4 uProjM;",
      "varying vec2 vCorner; varying float vRad; varying vec3 vCV; varying float vAlpha; varying float vSpeed;",
      "void main(){",
      "  float d2 = dot(vCorner, vCorner); if (d2 > 1.0) discard;",
      "  vec3 p = vCV + vec3(vCorner * vRad, sqrt(1.0 - d2) * vRad);",
      "  vec4 clip = uProjM * vec4(p, 1.0);",
      "  gl_FragDepthEXT = (clip.z / clip.w) * 0.5 + 0.5;",
      "  gl_FragColor = vec4(-p.z, 0.0, 0.0, 1.0);",
      "}"
    ].join("\n"),
    extensions: { fragDepth: true }, depthTest: true, depthWrite: true
  });
  var fluidThickMat = new THREE.ShaderMaterial({
    uniforms: { uRadius: radiusU },
    vertexShader: SPLAT_VERT,
    fragmentShader: [
      "varying vec2 vCorner; varying float vRad; varying vec3 vCV; varying float vAlpha; varying float vSpeed;",
      "void main(){",
      "  float d2 = dot(vCorner, vCorner); if (d2 > 1.0) discard;",
      "  float t = sqrt(1.0 - d2) * 2.0 * vRad * vAlpha;",
      "  gl_FragColor = vec4(t, t * vSpeed, 0.0, 0.0);",
      "}"
    ].join("\n"),
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    depthTest: false, depthWrite: false, transparent: true
  });
  var fluidScene = new THREE.Scene();
  var fluidMesh = new THREE.Mesh(fGeo, fluidDepthMat);
  fluidMesh.frustumCulled = false;
  fluidScene.add(fluidMesh);
  var blurU = { tDepth: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() }, uScale: { value: 1.0 } };
  var blurMat = new THREE.ShaderMaterial({
    uniforms: blurU, vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tDepth; uniform vec2 uDir; uniform vec2 uTexel; uniform float uScale; varying vec2 vUv;",
      "void main(){",
      "  float z0 = texture2D(tDepth, vUv).r;",
      "  if (z0 <= 0.0) { gl_FragColor = vec4(0.0); return; }",
      "  float sum = 0.0, ws = 0.0;",
      "  for (int i = -9; i <= 9; i++) {",
      "    float zi = texture2D(tDepth, vUv + uDir * uTexel * float(i) * uScale).r;",
      "    if (zi <= 0.0) continue;",
      "    float dz = (zi - z0) / 0.04;",
      "    float w = exp(-float(i * i) / 40.0) * exp(-dz * dz);",
      "    sum += zi * w; ws += w;",
      "  }",
      "  gl_FragColor = vec4(sum / max(ws, 1e-6), 0.0, 0.0, 1.0);",
      "}"
    ].join("\n"), depthTest: false, depthWrite: false
  });

  // ------------------------------------------- 5. volumetric single scatter
  var rSunU = { value: new THREE.Vector3(0, -1, 0) }, extU = { value: new THREE.Vector3(0.21, 0.065, 0.035) };
  var sunColU = { value: new THREE.Color(1, 1, 1) }, surfYU = { value: cfg.surfY }, oceanU = { value: 0 };
  var volU = {
    tDepth: { value: null }, tCaustic: { value: rtCaustic.texture }, uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uSurfY: surfYU,
    uTile: { value: TILE }, uRSun: rSunU, uExt: extU, uSunCol: sunColU, uScatter: { value: 0.035 }, uG: { value: 0.65 },
    uFrame: { value: 0 }, uMaxDist: { value: 45.0 }, uPoolHalf: { value: POOL_HALF }, uOcean: oceanU,
    tShadow: shadowTexU, uShadowMat: shadowMatU, uShadowOn: shadowOnU, uShadowTexel: shadowTexelU
  };
  var volMat = new THREE.ShaderMaterial({
    uniforms: volU, vertexShader: FS_VERT, defines: { VOL_STEPS: 32 },
    fragmentShader: SHADOW_GLSL + "\n" + [
      "uniform sampler2D tDepth; uniform sampler2D tCaustic; uniform mat4 uProjInv; uniform mat4 uCamWorld; uniform vec3 uCamPos;",
      "uniform float uSurfY; uniform float uTile; uniform vec3 uRSun; uniform vec3 uExt; uniform vec3 uSunCol; uniform float uScatter;",
      "uniform float uG; uniform float uFrame; uniform float uMaxDist; uniform float uPoolHalf; uniform float uOcean; varying vec2 vUv;",
      "float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }",
      "void main(){",
      "  float d = texture2D(tDepth, vUv).r;",
      "  vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); vp /= vp.w;",
      "  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;",
      "  vec3 rd = normalize(wp - uCamPos);",
      "  float dScene = d < 0.99999 ? length(wp - uCamPos) : 1e5;",
      "  float tS = 1e5;",
      "  if (abs(rd.y) > 1e-4) { float t = (uSurfY - uCamPos.y) / rd.y; if (t > 0.0) tS = t; }",
      "  float t0 = 0.0, t1 = min(dScene, uMaxDist);",
      "  if (uCamPos.y < uSurfY) { t1 = min(t1, tS); }",
      "  else { if (tS >= dScene) { gl_FragColor = vec4(0.0); return; } t0 = tS; t1 = min(dScene, tS + uMaxDist); }",
      "  if (t1 <= t0) { gl_FragColor = vec4(0.0); return; }",
      "  float jit = ign(gl_FragCoord.xy + uFrame * 5.588238);",
      "  float dt = (t1 - t0) / float(VOL_STEPS), cosR = max(0.2, -uRSun.y);",
      "  vec3 acc = vec3(0.0);",
      "  for (int i = 0; i < VOL_STEPS; i++) {",
      "    float t = t0 + (float(i) + jit) * dt;",
      "    vec3 p = uCamPos + rd * t;",
      "    float dep = uSurfY - p.y; if (dep <= 0.0) continue;",
      "    vec2 ps = p.xz - uRSun.xz * (dep / cosR);",
      "    float c = textureLod(tCaustic, ps / uTile, 3.0).r * 5.0;",
      "    c = mix(1.0, c, smoothstep(0.5, 4.0, dep) * 0.85);",
      "    if (uOcean < 0.5 && (abs(ps.x) > uPoolHalf || abs(ps.y) > uPoolHalf)) c = 0.0;",
      "    c *= sunShadow(p, 2.0, 1);",
      "    acc += exp(-uExt * (t - t0)) * exp(-uExt * dep / cosR) * c;",
      "  }",
      "  float mu = dot(uRSun, -rd), g = uG;",
      "  float ph = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));",
      "  gl_FragColor = vec4(acc * dt * uScatter * ph * uSunCol, 1.0);",
      "}"
    ].join("\n"), depthTest: false, depthWrite: false
  });

  // ---------------------------------------------------------- 6. composite
  var wavesU = [], waveOmU = [];
  for (var wq = 0; wq < 4; wq++) { wavesU.push(new THREE.Vector4()); waveOmU.push(0); }
  var compU = {
    tScene: { value: null }, tDepth: { value: null }, tVol: { value: null }, tFluid: { value: null }, tThick: { value: null },
    tWave: { value: waveA.texture }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uView: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    uSurfY: surfYU, uPoolHalf: { value: POOL_HALF }, uOcean: oceanU, uExt: extU, uWaterCol: { value: new THREE.Color() },
    uFogCol: { value: new THREE.Color() }, uSunAir: sunAirU, uRSun: rSunU, uSunCol: sunColU, uSkyInt: { value: 1.0 },
    uTime: timeU, uTile: { value: TILE }, uRippleAmp: rippleU, uWaves: { value: wavesU }, uWaveOm: { value: waveOmU },
    uCamUnder: { value: 1 }, uVolOn: { value: 1 }, uFluidOn: { value: 0 }, uRes: { value: new THREE.Vector2() },
    uHalfTexel: { value: new THREE.Vector2() }, uTanHalf: { value: new THREE.Vector2(0.4, 0.4) }, uWaveOn: { value: 1 },
    uFluidTint: { value: 1.0 }, uVolTexel: { value: new THREE.Vector2() }
  };
  var compMat = new THREE.ShaderMaterial({
    uniforms: compU, vertexShader: FS_VERT,
    fragmentShader: RIPPLE_GLSL + "\n" + [
      "uniform sampler2D tScene; uniform sampler2D tDepth; uniform sampler2D tVol; uniform sampler2D tFluid; uniform sampler2D tThick; uniform sampler2D tWave;",
      "uniform mat4 uProjInv; uniform mat4 uCamWorld; uniform mat4 uView; uniform mat4 uProj; uniform vec3 uCamPos;",
      "uniform float uSurfY; uniform float uPoolHalf; uniform float uOcean; uniform vec3 uExt; uniform vec3 uWaterCol; uniform vec3 uFogCol;",
      "uniform vec3 uSunAir; uniform vec3 uRSun; uniform vec3 uSunCol; uniform float uSkyInt;",
      "uniform vec4 uWaves[4]; uniform float uWaveOm[4]; uniform float uCamUnder; uniform float uVolOn; uniform float uFluidOn; uniform float uWaveOn;",
      "uniform vec2 uRes; uniform vec2 uHalfTexel; uniform vec2 uTanHalf; uniform float uFluidTint; uniform vec2 uVolTexel;",
      "varying vec2 vUv;",
      "vec3 skyColor(vec3 d){",
      "  float t = clamp(d.y, 0.0, 1.0);",
      "  vec3 c = mix(vec3(0.80, 0.88, 0.96), vec3(0.22, 0.48, 0.92), pow(t, 0.55));",
      "  float s = max(0.0, dot(d, -uSunAir));",
      "  c += uSunCol * (pow(s, 600.0) * 6.0 + pow(s, 24.0) * 0.18);",
      "  return c * uSkyInt;",
      "}",
      "vec3 waterBg(vec3 rd, float dep){",
      "  vec3 base = uWaterCol * exp(-uExt * 0.8 * max(dep, 0.0));",
      "  vec3 c = base * (0.45 + 0.75 * smoothstep(-1.0, 1.0, rd.y));",
      "  float mu = dot(rd, -uRSun);",
      "  float g = 0.8, ph = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));",
      "  c += uSunCol * ph * 0.02 * exp(-uExt * max(dep, 0.0)) * uVolOn;",
      "  return c;",
      "}",
      "vec2 surfSlope(vec2 xz, float dist){",
      "  vec2 s = rippleSlope(xz, uTime) / (1.0 + dist / 5.0);",
      "  if (uOcean > 0.5) {",
      "    for (int i = 0; i < 4; i++) { float ph = dot(uWaves[i].xy, xz) - uWaveOm[i] * uTime + uWaves[i].w; s -= uWaves[i].z * uWaves[i].xy * sin(ph); }",
      "  } else if (uWaveOn > 0.5) {",
      "    s += texture2D(tWave, (xz + uPoolHalf) / (2.0 * uPoolHalf)).ba;",
      "  }",
      "  return s;",
      "}",
      "vec3 fog(vec3 c, float d){ vec3 T = exp(-uExt * d); return c * T + uFogCol * (1.0 - T); }",
      "float depthOf(vec3 wp){ vec4 c = uProj * uView * vec4(wp, 1.0); return clamp((c.z / c.w) * 0.5 + 0.5, 0.0, 1.0); }",
      "vec3 viewPos(vec2 uv, float z){ return vec3((uv.x * 2.0 - 1.0) * uTanHalf.x * z, (uv.y * 2.0 - 1.0) * uTanHalf.y * z, -z); }",
      "void main(){",
      "  float d = texture2D(tDepth, vUv).r;",
      "  vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); vp /= vp.w;",
      "  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;",
      "  vec3 rd = normalize(wp - uCamPos);",
      "  bool bg = d >= 0.99999;",
      "  float dScene = bg ? 1e6 : length(wp - uCamPos);",
      "  bool under = uCamUnder > 0.5;",
      "  float tS = 1e6;",
      "  if (under ? rd.y > 1e-4 : rd.y < -1e-4) {",
      "    float t = (uSurfY - uCamPos.y) / rd.y; vec3 hp = uCamPos + rd * t;",
      "    if (t > 0.0 && (uOcean > 0.5 || (abs(hp.x) <= uPoolHalf && abs(hp.z) <= uPoolHalf))) tS = t;",
      "  }",
      "  vec3 col; float outDepth = d;",
      "  if (tS < dScene) {",
      "    vec3 hp = uCamPos + rd * tS;",
      "    vec2 sl = surfSlope(hp.xz, tS);",
      "    vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));",
      "    if (under) {",
      "      vec3 nd = -n;",
      "      vec3 tr = refract(rd, nd, 1.333);",
      "      vec3 rf = reflect(rd, nd);",
      "      vec3 reflC = waterBg(rf, 0.0) * 0.9;",
      "      if (dot(tr, tr) < 1e-6) col = reflC;",
      "      else {",
      "        float ct = abs(dot(tr, n));",
      "        float F = 0.0204 + 0.9796 * pow(1.0 - ct, 5.0);",
      "        col = mix(skyColor(tr) * 2.8, reflC, F);",
      "      }",
      "      col = fog(col, tS);",
      "    } else {",
      "      vec3 rf = reflect(rd, n);",
      "      float ci = clamp(dot(-rd, n), 0.0, 1.0);",
      "      float F = 0.0204 + 0.9796 * pow(1.0 - ci, 5.0);",
      "      vec2 duv = clamp(n.xz * 0.06, -0.03, 0.03);",
      "      vec3 below; float dU;",
      "      float d2 = texture2D(tDepth, vUv + duv).r;",
      "      if (d2 < 0.99999) { below = texture2D(tScene, vUv + duv).rgb; dU = max(0.0, dScene - tS); }",
      "      else { below = waterBg(refract(rd, n, 0.7502), 4.0); dU = 30.0; }",
      "      below = fog(below, dU);",
      "      col = mix(below, skyColor(rf), F);",
      "    }",
      "    outDepth = depthOf(hp);",
      "  } else if (bg) {",
      "    col = under ? waterBg(rd, uSurfY - uCamPos.y) : skyColor(rd);",
      "  } else {",
      "    col = texture2D(tScene, vUv).rgb;",
      "  }",
      "  if (uVolOn > 0.5) {",
      "    vec2 ht = uVolTexel * 0.75;",
      "    col += 0.2 * (texture2D(tVol, vUv).rgb + texture2D(tVol, vUv + vec2(ht.x, ht.y)).rgb + texture2D(tVol, vUv + vec2(-ht.x, ht.y)).rgb",
      "         + texture2D(tVol, vUv + vec2(ht.x, -ht.y)).rgb + texture2D(tVol, vUv - ht).rgb);",
      "  }",
      // ---------------- SPH fluid surface
      "  if (uFluidOn > 0.5) {",
      "    float fz = texture2D(tFluid, vUv).r;",
      "    vec4 th = texture2D(tThick, vUv);",
      "    float sceneZ = bg ? 1e6 : -vp.z;",
      "    if (fz > 0.0 && fz < sceneZ - 0.01 && th.r > 0.0005) {",
      "      vec3 P = viewPos(vUv, fz);",
      "      vec2 tx = vec2(uHalfTexel.x, 0.0), ty = vec2(0.0, uHalfTexel.y);",
      "      float zr = texture2D(tFluid, vUv + tx).r, zl = texture2D(tFluid, vUv - tx).r;",
      "      float zu = texture2D(tFluid, vUv + ty).r, zd = texture2D(tFluid, vUv - ty).r;",
      "      vec3 ddx = (zr > 0.0 ? viewPos(vUv + tx, zr) - P : P - viewPos(vUv - tx, zl));",
      "      vec3 ddx2 = (zl > 0.0 ? P - viewPos(vUv - tx, zl) : ddx);",
      "      if (abs(ddx2.z) < abs(ddx.z)) ddx = ddx2;",
      "      vec3 ddy = (zu > 0.0 ? viewPos(vUv + ty, zu) - P : P - viewPos(vUv - ty, zd));",
      "      vec3 ddy2 = (zd > 0.0 ? P - viewPos(vUv - ty, zd) : ddy);",
      "      if (abs(ddy2.z) < abs(ddy.z)) ddy = ddy2;",
      "      vec3 N = normalize(cross(ddx, ddy)); if (N.z < 0.0) N = -N;",
      "      vec3 V = normalize(-P);",
      "      float thick = th.r, spd = th.g / max(th.r, 1e-5);",
      "      float s01 = clamp(spd / 3.0, 0.0, 1.0);",
      "      vec3 tint = mix(vec3(0.55, 0.85, 1.0), vec3(0.85, 1.0, 1.1), s01);",
      "      vec2 ruv = clamp(vUv + N.xy * min(thick, 0.12) * 0.06, 0.001, 0.999);",
      "      vec3 refr = (tS < dScene || bg || texture2D(tDepth, ruv).r >= 0.99999) ? col : texture2D(tScene, ruv).rgb;",
      "      vec3 milky = refr * 1.2 + (uFogCol * 0.4 + uSunCol * 0.03 * exp(-uExt * max(0.0, uSurfY - uCamPos.y))) * tint;",
      "      refr = mix(refr, milky, (1.0 - exp(-thick * 9.0)) * (0.25 + 0.6 * s01) * uFluidTint);",
      "      vec3 Nw = normalize((uCamWorld * vec4(N, 0.0)).xyz);",
      "      vec3 Rw = reflect(rd, Nw);",
      "      float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);",
      "      vec3 envC = under ? waterBg(Rw, uSurfY - uCamPos.y) * 1.6 : skyColor(Rw);",
      "      vec3 L = normalize((uView * vec4(-uRSun, 0.0)).xyz);",
      "      float spec = pow(max(dot(N, normalize(L + V)), 0.0), 60.0);",
      "      vec3 fc = mix(refr, max(envC, refr), F * 0.35) + uSunCol * spec * 0.2;",
      "      fc = fog(fc, fz);",
      "      float alpha = (1.0 - exp(-thick * 12.0)) * 0.7 * smoothstep(0.25, 0.9, fz);",
      "      col = mix(col, fc, alpha);",
      "    }",
      "  }",
      "  gl_FragDepthEXT = outDepth;",
      "  gl_FragColor = vec4(col, 1.0);",
      "}"
    ].join("\n"),
    extensions: { fragDepth: true }, depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth
  });

  // -------------------------------------------------------------- 8. bloom
  var brightMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uThresh: { value: 2.2 }, uKnee: { value: 0.8 } }, vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tSrc; uniform float uThresh; uniform float uKnee; varying vec2 vUv;",
      "void main(){",
      "  vec3 c = texture2D(tSrc, vUv).rgb;",
      "  float br = max(c.r, max(c.g, c.b));",
      "  float soft = clamp(br - uThresh + uKnee, 0.0, 2.0 * uKnee); soft = soft * soft / (4.0 * uKnee + 1e-4);",
      "  float contrib = max(soft, br - uThresh) / max(br, 1e-4);",
      "  gl_FragColor = vec4(min(c * contrib, vec3(30.0)), 1.0);",
      "}"
    ].join("\n"), depthTest: false, depthWrite: false
  });
  var downMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;",
      "void main(){",
      "  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;",
      "  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;",
      "  gl_FragColor = vec4(c * 0.25, 1.0);",
      "}"
    ].join("\n"), depthTest: false, depthWrite: false
  });
  var upMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1.0 } }, vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGain; varying vec2 vUv;",
      "void main(){",
      "  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;",
      "  c += (texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 2.0;",
      "  c += texture2D(tSrc, vUv + uTexel).rgb + texture2D(tSrc, vUv - uTexel).rgb + texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture2D(tSrc, vUv + vec2(-uTexel.x, uTexel.y)).rgb;",
      "  gl_FragColor = vec4(c / 16.0 * uGain, 1.0);",
      "}"
    ].join("\n"),
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    depthTest: false, depthWrite: false, transparent: true
  });

  // --------------------------------------------- 9. tone map + FXAA output
  var finalU = {
    tHDR: { value: null }, tBloom: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: 1.0 },
    uBloom: { value: 0.14 }, uBloomOn: { value: 1 }, uGamma: { value: 1.0 }, uVignette: { value: 0.32 }
  };
  var finalMat = new THREE.ShaderMaterial({
    uniforms: finalU, vertexShader: FS_VERT,
    fragmentShader: [
      "uniform sampler2D tHDR; uniform sampler2D tBloom; uniform vec2 uTexel; uniform float uExposure; uniform float uBloom;",
      "uniform float uBloomOn; uniform float uGamma; uniform float uVignette; varying vec2 vUv;",
      "vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }",
      "vec3 aces(vec3 c){",
      "  const mat3 IM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);",
      "  const mat3 OM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);",
      "  c *= uExposure / 0.6; c = IM * c; c = RRTAndODTFit(c); c = OM * c; return clamp(c, 0.0, 1.0);",
      "}",
      "vec3 tm(vec2 uv){ vec3 c = texture2D(tHDR, uv).rgb; if (uBloomOn > 0.5) c += texture2D(tBloom, uv).rgb * uBloom; return pow(aces(c), vec3(1.0 / uGamma)); }",
      "float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }",
      "void main(){",
      "  vec3 rgbM = tm(vUv);",
      "  vec3 rgbNW = tm(vUv + vec2(-1.0, -1.0) * uTexel), rgbNE = tm(vUv + vec2(1.0, -1.0) * uTexel);",
      "  vec3 rgbSW = tm(vUv + vec2(-1.0, 1.0) * uTexel), rgbSE = tm(vUv + vec2(1.0, 1.0) * uTexel);",
      "  float lM = luma(rgbM), lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);",
      "  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));",
      "  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));",
      "  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);",
      "  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);",
      "  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;",
      "  vec3 rgbA = 0.5 * (tm(vUv + dir * (1.0 / 3.0 - 0.5)) + tm(vUv + dir * (2.0 / 3.0 - 0.5)));",
      "  vec3 rgbB = rgbA * 0.5 + 0.25 * (tm(vUv + dir * -0.5) + tm(vUv + dir * 0.5));",
      "  float lB = luma(rgbB);",
      "  vec3 col = (lB < lMin || lB > lMax) ? rgbA : rgbB;",
      "  vec2 q = vUv - 0.5; col *= 1.0 - uVignette * dot(q, q) * 1.6;",
      "  gl_FragColor = vec4(col, 1.0);",
      "}"
    ].join("\n"), depthTest: false, depthWrite: false
  });

  // -------------------------------------------------------------- API
  FX.causticTexture = rtCaustic.texture;
  FX.waveTexture = function () { return waveA.texture; };
  FX.tile = TILE;
  FX.maxParticles = MAXP;
  FX.uniforms = { comp: compU, vol: volU, final: finalU, caustic: causticMat.uniforms };
  FX.setSize = function (w, h) { if (w !== W || h !== H) allocTargets(w, h); };
  FX.setQuality = function (name) {
    Q = name === "uhd" ? { volFull: true, fluidFull: true, volSteps: 32 }
      : (name === "high" ? { volFull: false, fluidFull: true, volSteps: 24 } : { volFull: false, fluidFull: false, volSteps: 16 });
    volMat.defines.VOL_STEPS = Q.volSteps; volMat.needsUpdate = true;
    var N = name === "uhd" ? 1024 : 512, seg = name === "uhd" ? 256 : 180;
    if (rtCaustic.width !== N) {
      rtCaustic.dispose(); rtCaustic = makeCausticTarget(N);
      causticMesh.geometry.dispose(); causticMesh.geometry = makeCausticGeometry(seg);
      volU.tCaustic.value = rtCaustic.texture; FX.causticTexture = rtCaustic.texture;
      causticDirty = true;
    }
    if (W > 2) allocTargets(W, H);
  };
  FX.clearWaves = clearWaves;

  // particles: Float32Array pos (n*3, three world), data (n*4: radiusScale, alpha, speed, surf)
  FX.setParticles = function (n, pos, data) {
    n = Math.min(n, MAXP);
    aPos.array.set(pos.subarray(0, n * 3)); aData.array.set(data.subarray(0, n * 4));
    aPos.updateRange.offset = 0; aPos.updateRange.count = n * 3; aPos.needsUpdate = true;
    aData.updateRange.offset = 0; aData.updateRange.count = n * 4; aData.needsUpdate = true;
    fGeo.instanceCount = n;
  };

  var frame = 0, ping = true;
  FX.render = function (env) {
    var r = renderer, oldTM = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.autoClear = true;
    frame++;
    timeU.value = env.time;
    surfYU.value = env.surfY;
    oceanU.value = env.ocean ? 1 : 0;
    sunAirU.value.copy(env.sunAir);
    rSunU.value.copy(env.rSun);
    sunColU.value.copy(env.sunCol);
    extU.value.copy(env.ext);
    rippleU.value = env.rippleAmp;
    causticMat.uniforms.uDepth.value = env.causticDepth;

    // 1. ripple tank (pool only)
    if (!env.ocean && env.waves) {
      var nd = Math.min(16, env.drops.length);
      for (var i = 0; i < nd; i++) { var dd = env.drops[i]; drops[i].set(dd[0], dd[1], dd[2], dd[3]); }
      waveMat.uniforms.uNDrops.value = nd;
      waveMat.uniforms.tPrev.value = waveA.texture;
      pass(waveMat, waveB);
      var tmp = waveA; waveA = waveB; waveB = tmp;
    }
    compU.tWave.value = waveA.texture;
    compU.uWaveOn.value = (!env.ocean && env.waves) ? 1 : 0;

    // 2. caustics
    if (env.caustics || env.godrays || causticDirty) {
      if (!(env.caustics || env.godrays)) rippleU.value = 0.0;
      r.setRenderTarget(rtCaustic); r.setClearColor(0x000000, 0); r.clear();
      r.render(causticScene, fsCam);
      rippleU.value = env.rippleAmp;
      causticDirty = false;
    }

    // 2b. sun shadow map around the AUV
    shadowOnU.value = env.shadows ? 1 : 0;
    if (env.shadows) renderShadow(env.shadowTarget, env.rSun);

    // 3. opaque scene
    camera.layers.set(0);
    r.setRenderTarget(rtScene); r.setClearColor(0x000000, 1); r.clear();
    r.render(scene, camera);

    // matrices
    camera.updateMatrixWorld();
    var pInv = camera.projectionMatrixInverse;
    compU.uProjInv.value.copy(pInv); compU.uCamWorld.value.copy(camera.matrixWorld);
    compU.uView.value.copy(camera.matrixWorldInverse); compU.uProj.value.copy(camera.projectionMatrix);
    compU.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    volU.uProjInv.value.copy(pInv); volU.uCamWorld.value.copy(camera.matrixWorld); volU.uCamPos.value.copy(compU.uCamPos.value);
    var th = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    compU.uTanHalf.value.set(th * camera.aspect, th);
    compU.uCamUnder.value = env.camUnder ? 1 : 0;
    compU.uWaterCol.value.copy(env.waterCol); compU.uFogCol.value.copy(env.fogCol);
    compU.uSkyInt.value = env.skyInt;
    compU.uFluidTint.value = env.fluidTint;
    for (var w4 = 0; w4 < 4; w4++) {
      var wv = env.oceanWaves[w4];
      if (wv) { wavesU[w4].set(wv.kx, wv.ky, wv.a, wv.phase); waveOmU[w4] = wv.omega; } else { wavesU[w4].set(0, 0, 0, 0); waveOmU[w4] = 0; }
    }

    // 4. SPH fluid surface
    var fluidOn = env.fluid && fGeo.instanceCount > 0;
    compU.uFluidOn.value = fluidOn ? 1 : 0;
    if (fluidOn) {
      radiusU.value = env.particleRadius;
      projU.value.copy(camera.projectionMatrix);
      fluidMesh.material = fluidDepthMat;
      r.setRenderTarget(rtFD); r.setClearColor(0x000000, 0); r.clear();
      r.render(fluidScene, camera);
      fluidMesh.material = fluidThickMat;
      r.setRenderTarget(rtFT); r.clear();
      r.render(fluidScene, camera);
      blurU.tDepth.value = rtFD.texture; blurU.uDir.value.set(1, 0); pass(blurMat, rtFB);
      blurU.tDepth.value = rtFB.texture; blurU.uDir.value.set(0, 1); pass(blurMat, rtFD);
    }

    // 5. volumetric light
    compU.uVolOn.value = env.godrays ? 1 : 0;
    if (env.godrays) {
      volU.uFrame.value = frame % 64;
      volU.uScatter.value = env.scatter;
      pass(volMat, rtVol);
    }

    // 6. composite (writes depth for the transparent pass)
    r.setClearColor(0x000000, 1);
    pass(compMat, rtHDR);

    // 7. transparent geometry
    camera.layers.set(1);
    r.autoClear = false;
    r.setRenderTarget(rtHDR);
    r.render(scene, camera);
    r.autoClear = true;
    camera.layers.enableAll();

    // 8. bloom
    finalU.uBloomOn.value = env.bloom ? 1 : 0;
    if (env.bloom) {
      brightMat.uniforms.tSrc.value = rtHDR.texture;
      pass(brightMat, bloomRT[0]);
      for (var k = 1; k < bloomRT.length; k++) {
        downMat.uniforms.tSrc.value = bloomRT[k - 1].texture;
        downMat.uniforms.uTexel.value.set(1 / bloomRT[k - 1].width, 1 / bloomRT[k - 1].height);
        pass(downMat, bloomRT[k]);
      }
      r.autoClear = false;
      for (var u = bloomRT.length - 1; u > 0; u--) {
        upMat.uniforms.tSrc.value = bloomRT[u].texture;
        upMat.uniforms.uTexel.value.set(1 / bloomRT[u].width, 1 / bloomRT[u].height);
        pass(upMat, bloomRT[u - 1]);
      }
      r.autoClear = true;
    }

    // 9. output
    finalU.uExposure.value = env.exposure;
    pass(finalMat, null);
    r.toneMapping = oldTM;
  };

  allocTargets(2, 2);
  clearWaves();
  return FX;
}
