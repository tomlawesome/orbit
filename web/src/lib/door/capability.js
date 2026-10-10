/*
 * What this machine can carry, known at the page's start (CAPABILITIES.md: the probe).
 *
 * probe(): one throwaway context, one small shader of the Earth's kind of arithmetic (PROBE), compiled and timed,
 * then drawn four times into 512x512 and timed: how long a compile takes here, and how fast the GPU draws (ms per
 * million pixels). Kept for a week in this browser (keyed by the browser and the screen), so a later visit skips it.
 * level(): from that, the level this machine ships (CAPABILITIES.md: the ladder): 0 the still door, 1 the live door
 * lean, 2 the live door rich; liveDoor(): whether the door is live here (?door3d, and level 1 or 2).
 * doorWeight(): from that, the live door's weight (door3d.js): the rich Earth alone, the lean one alone, or both (the
 * lean first, the rich tried by the ladder), so only what will be drawn is compiled.
 */
import { note } from "./chores.js";
import { settings, flag } from "./settings.js";

const VERT = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

/* an Earth-like probe shader of about two thousand characters: a short march with noise and a few texture reads
   (the tests use the same: tests/common.js) */
export const PROBE = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform sampler2D uA, uB; uniform float uT; out vec4 o;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
vec2 sph(vec3 ro,vec3 rd,float R){ float b=dot(ro,rd), c=dot(ro,ro)-R*R, d=b*b-c; if(d<0.0) return vec2(-1.0); d=sqrt(d); return vec2(-b-d,-b+d); }
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 ro=vec3(0.0,0.0,-2.2), rd=normalize(vec3((uv-0.5)*vec2(uRes.x/uRes.y,1.0),1.2));
  vec2 t=sph(ro,rd,1.0), ta=sph(ro,rd,1.06);
  vec3 L=vec3(0.0), T=vec3(1.0);
  if(ta.y>0.0){ float t0=max(ta.x,0.0), t1=t.x>0.0?t.x:ta.y, ds=(t1-t0)/16.0;
    for(int i=0;i<16;i++){ vec3 x=ro+rd*(t0+ds*(float(i)+0.5)); float h=length(x)-1.0;
      float dr=exp(-h/0.02), dm=exp(-h/0.004); vec3 ext=vec3(5.8,13.5,33.1)*dr+vec3(21.0)*dm;
      float cl=texture(uA,x.xy*0.5+0.5+uT*0.01).r; float cd=smoothstep(0.4,0.8,cl+0.2*fbm(x*8.0))*step(h,0.02);
      vec3 ins=(vec3(5.8,13.5,33.1)*dr*0.06+vec3(21.0)*dm*0.02)*vec3(1.0,0.96,0.9)*20.0+cd*vec3(0.8);
      vec3 st=exp(-(ext+cd*30.0)*ds); L+=T*ins*(1.0-st)/max(ext+cd*30.0,vec3(1e-6)); T*=st; } }
  if(t.x>0.0){ vec3 P=ro+rd*t.x; vec2 g=vec2(atan(P.y,P.x)/6.2832+0.5,0.5-asin(clamp(P.z,-1.0,1.0))/3.14159);
    vec3 alb=pow(texture(uB,g).rgb,vec3(2.2)); float lit=max(dot(normalize(P),normalize(vec3(0.3,0.2,-1.0))),0.0);
    L+=T*(alb*lit*3.0+pow(texture(uA,g*4.0).rgb,vec3(2.2))*0.4); }
  o=vec4(1.0-exp(-L*0.35),1.0);
}`;

/* kept a week, for this browser on this screen */
const WEEK = 7 * 24 * 3600e3;
const KEY = () => `${settings.storagePrefix}-probe ${navigator.userAgent} ${screen.width}x${screen.height}@${devicePixelRatio || 1}`;
const FAILED = { background: null, compileMs: null, msPerMpx: null, ok: false };

/* the salt is code, not a comment (Safari hashes the source without its comments): no cache answers for the compiler */
const salted = (src) => src.replace(/out vec4 o;/, `out vec4 o; const float SALT=${Math.random().toFixed(6)};`)
  .replace(/o=vec4\(([^;]*)\);\s*}\s*$/, (m, inner) => `o=vec4(${inner})+vec4(SALT*1e-6); }`);
/* a small texture of noise, for the probe's maps */
function noise(gl, w, h, seed) {
  const d = new Uint8Array(w * h * 4); let s = seed;
  for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s & 255; }
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d); gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

async function measure() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false });
  if (!gl) return FAILED;
  try {
    const par = gl.getExtension("KHR_parallel_shader_compile"), background = !!par;
    /* a program, timed to its link status (in the background: looked at once it is done, so the page never waits) */
    const compile = async () => {
      const t0 = performance.now();
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, salted(PROBE))); gl.linkProgram(p);
      if (par) while (!gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR)) await new Promise((r) => setTimeout(r, 4));
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "probe: no program");
      return { p, ms: performance.now() - t0 };
    };
    /* in the background, twice, the second taken (a fresh context's first compile is 3-5x the rest on Safari); on the
       page's own thread once (each is a stall) */
    let pr = await compile();
    if (background) { gl.deleteProgram(pr.p); pr = await compile(); }
    /* drawn four times into 512x512, each waited for (a pixel read back); the mean of the last three */
    const A = noise(gl, 256, 128, 3), B = noise(gl, 256, 128, 7);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindVertexArray(gl.createVertexArray()); gl.viewport(0, 0, 512, 512); gl.useProgram(pr.p);
    const u = (n) => gl.getUniformLocation(pr.p, n);
    gl.uniform2f(u("uRes"), 512, 512); gl.uniform1f(u("uT"), 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, A); gl.uniform1i(u("uA"), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, B); gl.uniform1i(u("uB"), 1);
    const px = new Uint8Array(4), times = [];
    for (let i = 0; i < 4; i++) { const t0 = performance.now(); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - t0); }
    if (gl.getError() !== gl.NO_ERROR) return FAILED;
    const mean = (times[1] + times[2] + times[3]) / 3;
    return { background, compileMs: pr.ms, msPerMpx: mean / 0.262144, ok: true };
  } catch (e) {
    console.warn("orbit: no probe", e);
    return FAILED;
  } finally {
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* fine */ }
  }
}

/* the result, once the probe has resolved (doorWeight reads it) */
let got = null, memo = null;
/** the probe, once a page view: { background, compileMs, msPerMpx, ok } (ok false, the rest null, where it could not be
    had); a week's stored one where there is one */
export function probe() {
  if (memo) return memo;
  return (memo = (async () => {
    let r = null, how = "fresh";
    try { const s = JSON.parse(localStorage.getItem(KEY()) || "null"); if (s?.r?.ok && Date.now() - s.t < WEEK) { r = s.r; how = "stored"; } } catch { /* probed afresh */ }
    if (!r) {
      r = await measure().catch(() => FAILED);
      if (r.ok) try { localStorage.setItem(KEY(), JSON.stringify({ t: Date.now(), r })); } catch { /* this visit only */ }
    }
    got = r;
    note(r.ok ? `probe: compile ${Math.round(r.compileMs)} ms (${r.background ? "background" : "page thread"}), ${r.msPerMpx.toFixed(1)} ms per Mpx (${how})` : "probe: failed");
    return r;
  })());
}

/* the door's budget for a frame (door3d.js: BUDGET), and the probe's share for each weight (the measures' calibration:
   lean about 0.25 of the probe's ms per Mpx, rich up to 0.55) */
export const BUDGET = 40;
const RICH_K = 0.55, LEAN_K = 0.25;
/** the door's band in million device pixels, sized as door3d.js sizes it (the frame's y 640..1000, to 2x) */
export function doorMpx(W, H) {
  const s = Math.max(W / 1600, H / 1000), bh = Math.min(H, 360 * s), px = Math.min(devicePixelRatio || 1, 2);
  return (W * bh * px * px) / 1e6;
}
/** what each weight is predicted to take a frame here (ms), or null without a probe */
export function predicted(W, H, r = got) {
  if (!r?.ok) return null;
  const mpx = doorMpx(W, H);
  return { mpx, rich: r.msPerMpx * mpx * RICH_K, lean: r.msPerMpx * mpx * LEAN_K };
}
/** the door's weight, once the probe has resolved: "rich" (predicted to fit with room: the rich alone), "both" (it
    might: the lean first, the rich tried by the ladder), "lean" (it will not: the lean alone), or null without a
    probe (then both, as before). &rich and &lean say which, whatever the probe */
export function doorWeight(W, H, r = got) {
  if (flag("rich")) return "rich";
  if (flag("lean")) return "lean";
  const p = predicted(W, H, r);
  if (!p) return null;
  return p.rich <= 24 ? "rich" : p.rich <= BUDGET ? "both" : "lean";
}
/* the band: the door's world as it is laid out now (the window, where it is not yet) */
const band = () => {
  const box = document.querySelector("#door .world")?.getBoundingClientRect();
  return [box?.width || innerWidth, box?.height || innerHeight];
};

/* the live door, while it is tried (?door3d: the host's flag) */
const DOOR3D = () => !!flag("door3d");
/* a lean frame over this (predicted, ms) and the door stays still */
const LEAN_MAX = 16;
const NAMES = ["still", "live lean", "live rich"];
/* the level, chosen once a page view, after the probe, and said with why (CAPABILITIES.md: the ladder). 0, still:
   no WebGL2 or no probe, reduced motion or save-data, compiles on the page's own thread (each one stalls the page:
   the live door's could go nowhere but under the ring, and its loops would then run beside a page that stalls on
   every later compile), or a lean frame predicted over 16 ms. Else 2, live rich, where the rich is predicted to fit
   the budget (40 ms), and 1, live lean, where it is not. ?level=0|1|2 says which, whatever the probe */
let lvl = null;
export function level() {
  if (lvl !== null) return lvl;
  /* (asked before the probe has resolved: still, and not kept) */
  if (!got) return 0;
  let why;
  const asked = /^[012]$/.test(String(flag("level"))) ? String(flag("level")) : null;
  const quiet = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();
  const p = predicted(...band());
  if (asked) { lvl = +asked; why = `?level=${asked}`; }
  else if (!got.ok) { lvl = 0; why = "no WebGL2, or no probe"; }
  else if (quiet) { lvl = 0; why = "reduced motion"; }
  else if (navigator.connection?.saveData) { lvl = 0; why = "save-data"; }
  else if (p.lean > LEAN_MAX) { lvl = 0; why = `lean predicted ${Math.round(p.lean)} ms of ${LEAN_MAX}`; }
  /* compiles on the page's thread: the lean live door, and only once every journey is ready (lateDoor: the still door
     first, on the quick path, its compile a short stall on the still door after the ways in are open); never the
     rich one there (its weight, and the flight's rich Earth with it, would be two more such stalls) */
  else if (!got.background) { lvl = 1; why = `compiles stall the page; probe ${Math.round(got.compileMs)} ms: lean, after the ways in`; }
  else if (p.rich <= BUDGET) { lvl = 2; why = `predicted ${Math.round(p.rich)} ms of ${BUDGET}, background compiles`; }
  else { lvl = 1; why = `rich predicted ${Math.round(p.rich)} ms of ${BUDGET}, lean ${Math.round(p.lean)}`; }
  note(`level ${lvl}: ${NAMES[lvl]} (${why})`);
  return lvl;
}
/** whether the door is live here: ?door3d, and level 1 or 2 (after the probe has resolved) */
export const liveDoor = () => DOOR3D() && level() >= 1;
/** and whether it comes late: nothing of it compiled or drawn until every journey is ready (where compiles stall the
    page: the still door first, the live one after the ways in are open) */
export const lateDoor = () => liveDoor() && !!got && !got.background;

/* the door's weight, chosen once a page view, after the probe (door3d.js draws it; voyage.js compiles the flight's
   Earth to match, so the click's handoff does not change the clouds), and said with why. By the level: 1, the lean
   alone (the rich never made, whatever &rich says); 2, doorWeight's answer; 0, none (nothing of the live door is made) */
let chosen = null;
export function theDoorWeight() {
  if (chosen) return chosen;
  if (!got) return "both";
  const L = level();
  if (L === 0) return null;
  const [W, H] = band(), p = predicted(W, H);
  const asked = flag("rich") ? "rich" : flag("lean") ? "lean" : null;
  chosen = L === 1 ? "lean" : doorWeight(W, H) || "both";
  note(`door: weight ${chosen} (${L === 1 ? "level 1" : asked ? `&${asked}` : p ? `predicted ${Math.round(p.rich)} ms of ${BUDGET} for the rich, ${Math.round(p.lean)} for the lean, at ${p.mpx.toFixed(2)} Mpx` : "no probe"})`);
  return chosen;
}
