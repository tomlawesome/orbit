/*
 * THE DIAL'S SUN: FURNACE (#1250, design/v19/home-sun/round-2/furnace.html;
 * owner, 2026-10-06). No photograph: a physically-based model of a G-type
 * star drawn live by a small shader -- Pierce & Slaughter's limb darkening at
 * 5500 Å, convective granulation in two octaves of value noise foreshortened
 * towards the limb, a spot group with penumbrae, faculae, the chromosphere
 * rim, the streamer corona drifting with Baumbach's fall-off, the bloom in
 * closed form, the film's shoulder `1 - e^(-1.6x)`. On paper (dawn, clouds)
 * the shader draws the sunrise sun: a warm haze and no corona.
 *
 * The still (sun.py's `furnace()`, the same formulas run once) stands in
 * under reduced motion, where WebGL2 is missing, where this machine is too
 * slow for it (the flight's own rule, lib/flight/fitness.js), and until the
 * shader has drawn its first frame. The shader draws only while the sun is
 * on screen and the tab is showing.
 */
import { fitsFrame } from "$lib/flight/fitness.js";

/* The disc's radius in dial units (the 380-unit dial). Today's size; the
   owner has not ruled on the sample's 9.5 (round-2 README, "For the owner
   to rule on"). The pocket draws its sun 8/7 of the desk's, as it did. */
export const SUN_R = 7;
export const POCKET_SUN_R = (SUN_R * 8) / 7;
/* the disc's radius as a fraction of the picture's side (sun.py: a 36 px
   disc in a 320 px picture); the light beyond the disc fades out inside it */
export const UNIT = 0.1125;
/** the picture's side, in dial units, for a disc of radius `r` @param {number} r */
export const sideOf = (r) => r / UNIT;

/* the three suns (furnace.html's PACKS), verbatim */
export const FURNACE = {
  starchart: { light: 0, expo: 1.05, limb: "#f2b64a", mid: "#ffe9c4", core: "#fff6e6", rim: "#ff6e3a", c0: "#fff3dc", c1: "#d8b45a", c2: "#8a6cc0", haze: "#000000" },
  dawn: { light: 1, expo: 1.0, limb: "#a8420c", mid: "#e18a34", core: "#f3b060", rim: "#7e2c0a", c0: "#000000", c1: "#000000", c2: "#000000", haze: "#eda253" },
  retrograde: { light: 0, expo: 1.05, limb: "#c81e96", mid: "#ff4fd8", core: "#fff0fb", rim: "#4fe3ff", c0: "#ffd9f5", c1: "#ff4fd8", c2: "#6a3cff", haze: "#000000" },
};
/* After dark and clouds follow star chart and dawn respectively
   (home-sun round-1 README, carried into round 2) */
/** @type {Record<string, keyof typeof FURNACE>} */
const SUN_OF_PACK = { starchart: "starchart", afterdark: "starchart", clouds: "dawn", dawn: "dawn", retrograde: "retrograde" };
/** which sun a theme pack wears @param {string | undefined | null} theme */
export const sunOf = (theme) => SUN_OF_PACK[theme ?? ""] ?? "starchart";

/** @param {string} h */
const lin = (h) => [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

const FS = `
precision highp float;
uniform vec2 uRes; uniform float uT, uPx, uExpo, uLight;
uniform vec3 uLimb, uMid, uCore, uRim, uC0, uC1, uC2, uHaze;
float hash3(vec3 i){ return fract(sin(dot(i, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float x0 = mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), x1 = mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x);
  float x2 = mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), x3 = mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x);
  return mix(mix(x0, x1, f.y), mix(x2, x3, f.y), f.z); }
vec3 tint(float I){ return mix(mix(uLimb, uMid, smoothstep(0.15, 0.85, I)), uCore, smoothstep(0.7, 1.15, I)); }
vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec2 p = (gl_FragCoord.xy - uRes * 0.5) / (uRes.x * UNIT); p.y = -p.y;
  float r2 = dot(p, p), r = sqrt(r2), mu = sqrt(max(0.0, 1.0 - r2));
  float cover = clamp((1.0 - r) / uPx + 0.5, 0.0, 1.0);
  float t = uT;
  /* the photosphere: Pierce & Slaughter at 5500 Å; granules in two octaves; spots; faculae */
  float ld = 1.0 - 0.66 * (1.0 - mu) - 0.10 * (1.0 - mu * mu);
  vec2 q = p / 0.11; vec2 dir = p / max(r, 1e-3);
  q += dir * dot(dir, q) * (1.0 / max(mu, 0.25) - 1.0) * 0.5;
  float g1 = 1.0 - abs(vnoise(vec3(q, t * 0.5)) * 2.0 - 1.0), g2 = 1.0 - abs(vnoise(vec3(q * 2.7 + 7.0, t * 0.9)) * 2.0 - 1.0);
  float gran = smoothstep(0.25, 0.95, g1 * 0.7 + g2 * 0.3);
  float dark = 1.0;
  vec3 sp[3]; sp[0] = vec3(-0.42, 0.28, 0.11); sp[1] = vec3(-0.22, 0.33, 0.07); sp[2] = vec3(0.38, -0.47, 0.045);
  for (int k = 0; k < 3; k++){ float d = length(p - sp[k].xy), sr = sp[k].z;
    dark *= 0.12 + 0.88 * smoothstep(sr * 0.45, sr * 0.6, d); dark *= 0.72 + 0.28 * smoothstep(sr * 0.9, sr * 1.25, d); }
  float fac = smoothstep(0.55, 0.9, vnoise(vec3(q * 0.35 + 11.0, 2.0))) * pow(1.0 - mu, 1.5) * 0.5;
  float I = ld * (0.8 + 0.32 * gran) * dark * (1.0 + fac) * step(r2, 1.0);
  float h = max(r - 1.0, 0.0);
  if (uLight > 0.5){
    /* paper: the sunrise sun, a warm haze; no corona */
    vec3 col = tint(I * 0.95);
    float rimk = exp(-pow((r - 1.0) / 0.035, 2.0)) * (1.0 - cover) * 0.9;
    float ha = (0.62 * exp(-h / 0.32) + 0.30 * exp(-h / 1.4)) * (1.0 - cover) * smoothstep(4.4, 2.8, r);
    vec3 rgb = col * cover + uRim * rimk + uHaze * (1.0 - rimk) * ha;
    float a = clamp(cover + rimk + (1.0 - rimk) * ha, 0.0, 1.0);
    gl_FragColor = vec4(toSrgb(rgb / max(a, 1e-4)) * a, a); return;
  }
  vec3 disc = tint(I) * I * uExpo * cover;
  vec3 hdr = disc + uRim * exp(-pow((r - 1.0) / 0.02, 2.0)) * 0.9 * (1.0 - cover);
  /* the corona: Baumbach's fall-off, streamers in two scales, drifting */
  float rr = max(r, 1.0), lr = log(rr), a = atan(p.y, p.x) + t * 0.02;
  float n1 = vnoise(vec3(cos(a) * 4.0, sin(a) * 4.0, lr * 1.4 + t * 0.1)), n2 = vnoise(vec3(cos(a) * 11.0, sin(a) * 11.0, lr * 2.6 + 3.0 + t * 0.1));
  float stream = 0.62 + 0.55 * n1 * n1 + 0.22 * n2 * n2 * n2;
  float fall = 0.45 * pow(rr, -2.5) + 0.35 * pow(rr, -7.0);
  vec3 ccol = mix(mix(uC0, uC1, smoothstep(0.0, 1.6, lr)), uC2, smoothstep(1.8, 3.6, lr));
  float edge = smoothstep(4.4, 2.6, r);
  hdr += ccol * stream * fall * 0.9 * smoothstep(0.98, 1.05, r) * edge;
  /* the bloom, as the still has it (two gaussians of the disc), in closed form */
  vec3 bl = tint(0.8) * uExpo * 0.72;
  hdr += bl * (0.09 * exp(-h * h / 0.1) + 0.07 * exp(-h * h / 1.45) * 0.55) * edge;
  vec3 rgb = 1.0 - exp(-hdr * 1.6);
  float lum = max(rgb.r, max(rgb.g, rgb.b));
  float aOut = max(cover, clamp(lum, 0.0, 1.0));
  gl_FragColor = vec4(toSrgb(clamp(rgb / max(aOut, 1e-4), 0.0, 1.0)) * aOut, aOut);
}`.replace("UNIT", String(UNIT));
const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

/* the drawing is never larger than this, in device pixels (furnace.html:
   "at most 256 px square at 2×") */
const MAX_PX = 256;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Bring one sun to life. `box` is the sun's picture (its still is the box's
 * own background); `canvas` sits inside it and is shown, by the `live` class
 * on `box`, only once the shader has drawn. Nothing is made until the sun is
 * first on screen. Returns the teardown.
 * @param {HTMLElement} box
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void}
 */
export function mountFurnace(box, canvas) {
  if (reduced() || typeof IntersectionObserver === "undefined") return () => {};
  /** @type {WebGL2RenderingContext | null} */
  let gl = null;
  /** @type {Record<string, WebGLUniformLocation | null>} */
  let u = {};
  let failed = false, onScreen = false, raf = 0, w = 0;
  const t0 = performance.now();
  const root = document.documentElement;

  /** @param {keyof typeof FURNACE} key */
  function setSun(key) {
    if (!gl) return;
    const P = FURNACE[key];
    gl.uniform1f(u.uExpo, P.expo); gl.uniform1f(u.uLight, P.light);
    for (const k of /** @type {const} */ (["limb", "mid", "core", "rim", "c0", "c1", "c2", "haze"])) {
      gl.uniform3fv(u["u" + k[0].toUpperCase() + k.slice(1)], lin(P[k]));
    }
  }
  function size() {
    if (!gl) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const next = Math.max(1, Math.min(MAX_PX, Math.round(box.clientWidth * dpr)));
    if (next === w) return;
    w = next; canvas.width = w; canvas.height = w;
    gl.viewport(0, 0, w, w);
    gl.uniform2f(u.uRes, w, w); gl.uniform1f(u.uPx, 1 / (w * UNIT));
  }
  function draw() {
    if (!gl) return;
    gl.uniform1f(u.uT, (performance.now() - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** @returns {boolean} */
  function make() {
    const ctx = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!ctx) return false;
    gl = ctx;
    try {
      /** @param {number} type @param {string} src */
      const sh = (type, src) => {
        const o = /** @type {WebGLShader} */ (ctx.createShader(type)); ctx.shaderSource(o, src); ctx.compileShader(o);
        if (!ctx.getShaderParameter(o, ctx.COMPILE_STATUS)) throw new Error(ctx.getShaderInfoLog(o) ?? "shader");
        return o;
      };
      const pr = /** @type {WebGLProgram} */ (ctx.createProgram());
      ctx.attachShader(pr, sh(ctx.VERTEX_SHADER, VS)); ctx.attachShader(pr, sh(ctx.FRAGMENT_SHADER, FS));
      ctx.linkProgram(pr);
      if (!ctx.getProgramParameter(pr, ctx.LINK_STATUS)) throw new Error(ctx.getProgramInfoLog(pr) ?? "program");
      ctx.useProgram(pr);
      const b = ctx.createBuffer(); ctx.bindBuffer(ctx.ARRAY_BUFFER, b);
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
      const loc = ctx.getAttribLocation(pr, "p"); ctx.enableVertexAttribArray(loc); ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);
      for (const n of ["uRes", "uT", "uPx", "uExpo", "uLight", "uLimb", "uMid", "uCore", "uRim", "uC0", "uC1", "uC2", "uHaze"]) u[n] = ctx.getUniformLocation(pr, n);
      size(); setSun(sunOf(root.dataset.theme));
      /* the first draw finishes the driver's own compile; the second is the
         one timed against the flight's rule */
      draw();
      if (!fitsFrame(ctx, draw)) throw new Error("too slow here");
    } catch {
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
      gl = null;
      return false;
    }
    canvas.addEventListener("webglcontextlost", () => { failed = true; gl = null; box.classList.remove("live"); stop(); });
    box.classList.add("live");
    return true;
  }

  function frame() { raf = 0; draw(); loop(); }
  function loop() { if (!raf && gl && onScreen && !document.hidden) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function wake() {
    if (failed || !onScreen || document.hidden) { stop(); return; }
    if (!gl && !make()) { failed = true; return; }
    loop();
  }

  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    wake();
  });
  io.observe(box);
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => size());
  ro?.observe(box);
  const mo = new MutationObserver(() => setSun(sunOf(root.dataset.theme)));
  mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", wake);

  return () => {
    stop(); io.disconnect(); ro?.disconnect(); mo.disconnect();
    document.removeEventListener("visibilitychange", wake);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null; box.classList.remove("live");
  };
}
