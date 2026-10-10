/*
 * THE DOOR, LIVE (?door3d, while it is tried): the Earth under the door drawn as it is, not as a picture.
 *
 * The same Earth the flight draws (voyage.js), from the same camera, on the same limb, so its first frame is the
 * door's picture (tools/dawn.py) and the picture can go without being seen to. Then it lives: the ground turns
 * slowly under the camera, the other way to the stars' drift over it; the clouds drift over the ground; and the sun
 * hangs at the edge of rising, a little nearer and a little further, its first light shimmering on the limb.
 *
 * Only the Earth and its air are drawn, in the band at the foot of the door they fill, over the door's own sky and
 * its glows (which stay as they are): where the Earth is, it covers them; above the limb its air is added to them.
 * One pass, no targets, a slow clock (the motion is slow: twenty frames a second carries it), and nothing at all
 * while the door is not shown. Made as chores (chores.js), after the door's painted reveal (main.js: liveDoorOf);
 * the picture stays until then.
 *
 * Drawn at the screen's own density (to 2×), and in two weights (voyage.js: sceneHead, the Earth's part alone: door,
 * so its compile does not carry the whole flight's code it never runs): the lean, the clouds a flat cover on the
 * ground; the rich, dawn.py's cloud slab. Which are compiled is chosen at the page's start by the probe
 * (capability.js: doorWeight), so only what will be drawn is: "rich", the rich alone, from the first frame, measured
 * once, drawn coarser if it must be (to half), and only if even that is over 40 ms a frame is the lean one compiled
 * and drawn instead; "lean", the lean alone (coarser if it must be), the rich never made; "both" (and without a
 * probe), the lean first, measured once after its first frame: with room to spare (16 ms a frame or less) the rich
 * one is made, measured the same way, and kept if it keeps to 40 ms (20 a second, with room), the flight then asked to
 * draw the same from the handoff on; otherwise the lean one stays, and if even that takes more than 40 ms the density
 * comes down by the square root of the excess (to half), and stays. To try them: &rich (the rich one alone, kept
 * whatever it takes; still measured), &lean (the lean one alone).
 *
 * Proved before it is shown: the first frame is drawn into the canvas while it is still unseen (site.css: canvas.live,
 * until .world.live), measured there, drawn coarser (or the lean one made) if the measure says so, and only then shown
 * (doorMeasured: the world planets, install.js, start only after that, so the measure is the door's alone). Made at
 * all only where the level allows it (capability.js: level 1, the lean alone; 2, the weights above).
 *
 * Each measure waits for the chores to be at rest (chores.js: quiet), so it times the drawing alone, not an upload or
 * a compile beside it. Where the browser compiles on the page's own thread (COMPILES_ASIDE false), the weights chosen
 * (and with the rich one the flight's: voyage.js, compileRich) are compiled at the page's start (compileDoor), with
 * every other compile, under the first light's ring, which main.js holds until they are done (chores: "compile"), so
 * no compile ever freezes the reveal or a live loop; with "both", the rich one is still drawn only if the ladder keeps
 * it. The rich weight's two passes (the clouds' field, the cities' glow: voyage.js, cloudField, cityGlow) are drawn
 * by the rich program itself, so they are made once it is there, before its first measure.
 */
import { chore, fetchOnce, note, quiet, linked, counted, compilesAside } from "./chores.js";
import { flag } from "./settings.js";
import { sceneHead, PASS_SWITCH, pictures, EURO, NEAR, BOXED, doorCamera, followDoor, sunTexture, theStrip, sharpStrip, cloudField, cityGlow, wantRich, compileRich } from "./voyage.js";
import { probe, theDoorWeight, lateDoor, BUDGET, liveDoor as doorIsLiveHere } from "./capability.js";
import { uploadBanded } from "./upload.js";

/* when this was loaded: how long the first compile then waited its turn is said (note) */
const LOADED = performance.now();
const RICH = () => !!flag("rich"), LEAN = () => !!flag("lean");

const VERT = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const MAIN = `
/* where the sun comes up on the limb (css px), and how strongly its first light shows there; where the band's top
   fades in (css px: its start, its length) */
uniform vec2 uSunPt, uFade; uniform float uFirst;
void main(){
${PASS_SWITCH}  vec2 css=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uPx;
  float cov; vec3 e=earthAA(css,cov);
  /* the first light: a bead of the sun along the limb, shimmering as the air over it moves */
  float s=uCirc.z/3000.0;
  vec2 p=css-uSunPt;
  float along=exp(-pow(p.x/(150.0*s),2.0)), across=exp(-pow((p.y+1.5*s)/(2.2*s+0.7),2.0));
  float sh=0.75+0.5*vnoise(vec3(p.x/(9.0*s),uTime*0.3,1.3))*vnoise(vec3(p.x/(23.0*s)+4.0,uTime*0.13,7.1));
  e+=vec3(1.0,0.66,0.4)*along*across*sh*uFirst*0.7;
  /* the picture's own film (dawn.py: tonemap, --expo 0.35), faded in over the band's top as the picture is */
  float f=clamp((css.y-uFade.x)/uFade.y,0.0,1.0);
  vec3 c=(1.0-exp(-max(e,0.0)*0.35))*f*f*(3.0-2.0*f);
  /* and laid over the door's sky as the picture is: where the Earth is it covers the sky; above the limb its air is
     a light over it, as opaque as it is bright (premultiplied) */
  float a=clamp(max(cov,max(c.r,max(c.g,c.b))*(1.0-cov)),0.0,1.0);
  c=a>1e-4?min(c/a,1.0):vec3(0.0);
  c=pow(c,vec3(1.0/2.2))+(hash13(vec3(gl_FragCoord.xy,uTime*60.0))-0.5)/255.0;
  o=vec4(c*a,a);
}`;
const FRAG = (slab) => sceneHead({ slab, door: true }) + MAIN;

/* the ground turns once in this long (s: three hours and twenty minutes, all but still), the clouds drift a quarter of a degree a minute
   over it, the sun rises and sinks a little (degrees under the horizon) */
const TURN = 12000, CLOUD = 1 / 360 / 240, SUN = 0.15;
/* the air's light over the limb, against the flight's: the door has shown its two pictures one over the other
   (dawn-pre under dawn), and their air adds up to this much more (fitted against them) */
const AIR = 1.4;

/* the door's canvas and context, made once: at the page's start where compiles freeze the page (compileDoor, for its
   programs to be compiled under the first light's ring), else by liveDoor. Nothing is put on its GPU until liveDoor */
let ctx = null;
function context() {
  if (ctx) return ctx;
  const canvas = document.createElement("canvas");
  canvas.className = "wl live";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  return (ctx = { canvas, gl, par: gl?.getExtension("KHR_parallel_shader_compile") || null, weights: {}, richFlight: null });
}
const shader = (gl, type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
const make = (gl, slab) => {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, FRAG(slab)));
  gl.linkProgram(p); linked("door");
  return p;
};
const finish = (gl, p) => {
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "door3d: no program");
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), u = {};
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, a.name); }
  return { p, u };
};
const compiled = (gl, par, p) => new Promise((resolve) => {
  if (!par) { resolve(); return; }
  const poll = () => (gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR) ? resolve() : setTimeout(poll, 40));
  poll();
});
/* a weight made, once: its program asked for, waited for (in the background where the browser can), and finished.
   Said: how long the first waited its turn, and how long the making itself took (since: the clock the console's
   lines are read against) */
/* (where compiles freeze the page, the weights chosen are "compile" chores, first of all; the rich one asks for the
   flight's rich one in its turn, so that is queued with them. Elsewhere the first is a "door" chore, and the rich one
   tried after the lean ("both") a "rich" one, last of all) */
let asked = 0, compiledFirst = null;
const firstCompiled = new Promise((resolve) => { compiledFirst = resolve; });
/** the weight drawn first, compiled (main.js says how many programs were compiled before the door) */
export const doorFirstCompiled = () => firstCompiled;
/** the door's first measure taken and its decision made (and so the door shown), or never to be: at once where the
    door is not live here (level 0, or no ?door3d), has no WebGL2, or fails. The world planets wait for it (install.js:
    doorPlanets), so the door's measure is not taken beside them */
let measuredNow = null;
export const doorMeasured = new Promise((resolve) => { measuredNow = resolve; });
probe().then(() => { if (!doorIsLiveHere()) measuredNow(); }, () => measuredNow());
function weight(slab, since) {
  /* (up: compiled under the ring, where compiles stall the page; not when the door comes late, capability.js: then a
     "door" chore after the journeys, a stall on the still door once the ways in are open) */
  const c = context(), { gl, par } = c, name = slab ? "rich" : "lean", up = !compilesAside() && !lateDoor();
  if (c.weights[name]) return c.weights[name];
  const first = !asked++;
  let took = 0;
  return (c.weights[name] = chore(() => {
    const t0 = performance.now();
    if (first) note(`door: compile waited ${Math.round(t0 - LOADED)} ms`, since);
    if (slab && up) c.richFlight = compileRich();
    const p = make(gl, slab);
    return compiled(gl, par, p).then(() => { took = performance.now() - t0; return p; });
  }, up ? 20 : 60, up ? "compile" : slab && !first ? "rich" : "door")
    .then((p) => chore(() => {
      const t0 = performance.now(), pr = finish(gl, p);
      note(`door: ${name} compiled ${Math.round(took + performance.now() - t0)} ms${counted("door")}`, since);
      if (first) compiledFirst();
      return pr;
    }, up ? 20 : 60, up ? "compile" : "door")));
}
/** where the browser compiles on the page's own thread (COMPILES_ASIDE false), asked for at the page's start
    (main.js): the weights chosen (capability.js: the rich alone, the lean alone, or both) queued as "compile" chores,
    and with the rich one the flight's rich one, done under the first light's ring; resolves once they are compiled,
    and main.js holds the door until then. Only the context and the programs: the maps, the canvas and the loop are
    liveDoor's, after the reveal. Elsewhere, nothing */
export function compileDoor() {
  if (compilesAside() || !context().gl) return Promise.resolve();
  return probe().then(() => {
    if (lateDoor()) return;
    const w = theDoorWeight();
    return Promise.all(w === "lean" ? [weight(false, LOADED)] : w === "rich" ? [weight(true, LOADED)] : [weight(false, LOADED), weight(true, LOADED)]);
  }).then(() => ctx.richFlight);
}

export function liveDoor(world) {
  const { canvas, gl } = context();
  if (!gl) { measuredNow(); return null; }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const since = performance.now();
  /* the pictures down the wire at once; only putting them on the GPU waits its turn. The sharpest lights at the
     sharpness this screen shows (theStrip: the flight then draws the same), the smallest of them first, the screen's
     own faded in over it after everything else, here and in the flight alike (sharpStrip) */
  const strip = theStrip(), stripS = sharpStrip();
  const keys = ["lights", "euro", "clouds", "day", "lightsN", "cloudsN", "dayN", "lightsS"];
  for (const k of keys) fetchOnce(pictures()[k]).catch(() => {});

  /* prog: the weight drawn ({ p, u }: the lean one, or the rich one once it is kept); mode: the weights chosen (the
     probe's: capability.js); rich: the rich program, once there is one (its passes draw the fields and the glow) */
  let prog = null, sunTex = null, glowT = null, mode = "both", rich = null;
  /* mipped: the maps whose mipmaps are made too (a field is made from a map only then) */
  const maps = {}, dims = {}, fields = {}, mipped = new Set();
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  const anisoK = aniso ? Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;
  /* a map not (yet) there is drawn without: black in its place, and its flag down (uHas, uHasN) */
  const blank = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  /* a map's own parameters: its wrap, and (with its mipmaps) the anisotropy, as the ground is seen almost edge on:
     without it the cities blur into the coarsest maps */
  const wrapOf = (key) => (g) => {
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, BOXED.includes(key) ? g.CLAMP_TO_EDGE : g.REPEAT);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  };
  const sharper = (g) => { if (aniso) g.texParameterf(g.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisoK); };
  /* the sharper strip, put on the GPU whole (sharpStrip: in every context in the one chore, its fade started on the
     same clock; the last chore of all) */
  const upload = (key, bm) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    sharper(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    wrapOf(key)(gl);
    return t;
  };
  /* the rich weight's fields, one a clouds map (voyage.js: cloudField), drawn by the rich program: made as soon as the
     map and the program are both there; and the cities' glow (cityGlow), once every map has come */
  const fieldOf = (key) => {
    if (!rich || !maps[key] || !mipped.has(key) || fields[key]) return;
    try { fields[key] = cloudField(gl, rich, maps[key], ...dims[key], key === "cloudsN"); } catch (e) { console.warn("orbit: no cloud field", e); }
  };
  const richMaps = () => {
    fieldOf("clouds"); fieldOf("cloudsN");
    if (rich && !glowT && maps.lights) glowT = cityGlow(gl, rich, maps.lights, ...dims.lights, maps.lightsN, blank);
  };
  /* each map put on the GPU a band at a time (upload.js: soft chores), its mipmaps after; drawable from its last band
     (its first level alone, LINEAR: the canvas is not on the page until every map is in, mipmaps and all) */
  const load = (key) => fetchOnce(pictures()[key])
    .then((b) => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bm) => {
      const wh = [bm.width, bm.height];
      return uploadBanded(gl, bm, { tag: "door", name: `door ${key}`, setup: wrapOf(key), after: sharper, drawable: (t) => { maps[key] = t; dims[key] = wh; } });
    })
    .then(() => {
      mipped.add(key);
      /* a clouds map's slab field, made with it if the rich program is already there (else with it: richMaps) */
      if (key === "clouds" || key === "cloudsN") fieldOf(key);
    })
    .catch(() => { /* drawn without it */ });
  const vao = gl.createVertexArray();

  /* the band the Earth fills: the frame's y 640..1000 (as the picture is laid), at the door's own scale */
  /* scale: the share of the screen's density drawn; 1 until the one measure (measure, below) says otherwise */
  let W = 0, H = 0, s = 1, top = 0, px = 1, scale = 1;
  function resize() {
    const r = world.getBoundingClientRect();
    W = r.width || innerWidth; H = r.height || innerHeight; s = Math.max(W / 1600, H / 1000);
    top = Math.max(0, H - 360 * s);
    const bh = H - top;
    /* at the screen's own density (the cities are points, the limb a line), unless the machine cannot keep up */
    px = Math.min(devicePixelRatio || 1, 2) * scale;
    canvas.width = Math.max(1, Math.round(W * px)); canvas.height = Math.max(1, Math.round(bh * px));
    Object.assign(canvas.style, { top: `${top}px`, height: `${bh}px`, bottom: "auto" });
    dirty = true;
  }
  let dirty = true;
  /* the frame's y (laid bottom-up, xMidYMax, as every door layer is) in the band's own css pixels */
  const ly = (y) => H - (1000 - y) * s - top;

  /* the door's turn, kept so the flight takes it up where it is (voyage.js: followDoor) */
  /* (rich: the door has kept its rich weight, so the flight draws the same once it has made it: voyage.js, wantRich) */
  const state = { spinM: [1, 0, 0, 0, 1, 0, 0, 0, 1], cloudOff: 0, sun: null, air: AIR, rich: false };
  /* the door's own clock (s): it runs only while the door is shown, so a journey away and back finds the Earth
     just as it was left, and the flight's last frame and the door's first are the same */
  let clock = 0;
  /* a target of the canvas's size, for a measure taken while the canvas is seen (tryRich): drawn into, never shown */
  let off = null;
  const unseen = () => {
    if (off && off.w === canvas.width && off.h === canvas.height) return off.f;
    if (off) { gl.deleteTexture(off.t); gl.deleteFramebuffer(off.f); }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    off = { t, f, w: canvas.width, h: canvas.height };
    return f;
  };
  /* into: a framebuffer to draw into instead of the canvas (a measure of a weight not yet kept, while the canvas is seen) */
  function draw(into = null) {
    if (!prog) return;
    /* the sun table, put on the GPU with the first frame (not with the compile, which may come before the reveal) */
    if (!sunTex) sunTex = sunTexture(gl);
    const u = prog.u;
    const t = reduced ? 0 : clock;
    const cam = doorCamera(SUN + (reduced ? 0 : 0.03 * Math.sin((t / 110) * 6.2832) + 0.012 * Math.sin((t / 41) * 6.2832 + 1.3)));
    /* the ground turned about the camera's own vertical: the horizon slides to the right, the stars drift to the left */
    const Z = [-cam.B[6], -cam.B[7], -cam.B[8]], a = (t / TURN) * 6.2832, c = Math.cos(a), sn = Math.sin(a), k = 1 - c;
    const M = [
      c + Z[0] * Z[0] * k, Z[1] * Z[0] * k + Z[2] * sn, Z[2] * Z[0] * k - Z[1] * sn,
      Z[0] * Z[1] * k - Z[2] * sn, c + Z[1] * Z[1] * k, Z[2] * Z[1] * k + Z[0] * sn,
      Z[0] * Z[2] * k + Z[1] * sn, Z[1] * Z[2] * k - Z[0] * sn, c + Z[2] * Z[2] * k,
    ];
    state.spinM = M; state.cloudOff = t * CLOUD; state.sun = cam.S;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into); gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog.p); gl.bindVertexArray(vao);
    gl.uniform2f(u.uRes, canvas.width, canvas.height); gl.uniform1f(u.uPx, canvas.width / W);
    gl.uniform1f(u.uTime, t % 1000);
    gl.uniform3f(u.uCirc, W / 2, ly(3920), 3000 * s);
    gl.uniform1f(u.uD, cam.D0); gl.uniform1f(u.uAirK, AIR);
    gl.uniformMatrix3fv(u.uB, false, new Float32Array(cam.B)); gl.uniform3fv(u.uSun, cam.S);
    gl.uniformMatrix3fv(u.uSpinM, false, new Float32Array(M)); gl.uniform1f(u.uCloudOff, state.cloudOff);
    gl.uniform4f(u.uHas, maps.lights ? 1 : 0, maps.euro ? 1 : 0, maps.clouds && maps.day ? 1 : 0, 0);
    gl.uniform4f(u.uEuroBox, ...EURO); gl.uniform4f(u.uNearBox, ...NEAR);
    gl.uniform4f(u.uHasN, maps.lightsN ? 1 : 0, maps.cloudsN ? 1 : 0, maps.dayN ? 1 : 0, 0);
    gl.uniform1f(u.uCloudK, maps.clouds ? 1 : 0);
    gl.uniform4f(u.uStripBox, ...strip.box); gl.uniform1f(u.uHasS, maps.lightsS ? 1 : 0);
    /* the sharper strip fading in (with reduced motion, simply there); once in, the small one let go */
    let mixS = maps.lightsS2 ? (reduced ? 1 : stripS.mix()) : 0;
    if (mixS >= 1) { gl.deleteTexture(maps.lightsS); maps.lightsS = maps.lightsS2; maps.lightsS2 = null; mixS = 0; }
    gl.uniform1f(u.uStripMix, mixS);
    gl.uniform2f(u.uSunPt, W / 2, ly(920)); gl.uniform2f(u.uFade, ly(640), 60 * s);
    gl.uniform1f(u.uFirst, reduced ? 0.5 : 0.5 + 0.25 * Math.sin((t / 110) * 6.2832 + 3.1416));
    const bind = (unit, tx, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tx); gl.uniform1i(loc, unit); };
    bind(0, maps.lights || blank, u.uLights); bind(1, maps.day || blank, u.uDay); bind(2, maps.clouds || blank, u.uClouds);
    bind(3, maps.euro || blank, u.uEuro); bind(4, maps.lightsN || blank, u.uLightsN); bind(5, maps.cloudsN || blank, u.uCloudsN);
    bind(6, maps.dayN || blank, u.uDayN); bind(7, sunTex, u.uSunT); bind(8, maps.lightsS || blank, u.uLightsS); bind(12, maps.lightsS2 || blank, u.uLightsS2);
    bind(9, fields.clouds || blank, u.uCloudF); bind(10, fields.cloudsN || blank, u.uCloudFN); bind(11, glowT || blank, u.uGlow);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    dirty = false;
  }

  /* the clock: twenty frames a second while the door is shown and the page is seen; nothing otherwise */
  let raf = 0, last = 0, prev = 0;
  const door = world.closest("#door");
  /* and not from the moment a journey begins (the flight draws its own Earth from this one's state; a dive blurs the
     door): the last frame stays as a still, so nothing of the door's costs while the journey comes up */
  const away = () => /\b(launching|departing|showwarp)\b/.test(document.body.className);
  const shown = () => !document.hidden && door && !door.hidden && !away() && getComputedStyle(door).opacity !== "0";
  function tick(now) {
    raf = 0;
    if (!shown()) { prev = 0; return; }
    clock += prev ? Math.min(now - prev, 100) / 1000 : 0; prev = now;
    if (dirty || (!reduced && now - last >= 48)) { last = now; draw(); }
    if (!reduced) raf = requestAnimationFrame(tick);
  }
  /* (and only once it is shown: until then the canvas is drawn only to be measured) */
  let seen = false;
  const wake = () => { if (!raf && prog && seen) raf = requestAnimationFrame(tick); };

  /* a measure, after a weight's first frame: three frames, each waited for (a pixel read back, as voyage.js's
     calibrate does), the last two timed (the first may still be finishing the driver's work); their mean (ms) */
  /* (the budget, 40 ms, is capability.js's, which predicts against it) */
  const ROOM = 16;
  /* (hidden: drawn into the unseen target, so a weight tried while the door is shown is never seen before it is kept) */
  function measure(hidden = false) {
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const into = hidden ? unseen() : null, ms = [];
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); draw(into); sync(); ms.push(performance.now() - t0); }
    if (!hidden) dirty = false;
    return (ms[1] + ms[2]) / 2;
  }
  /* over budget, drawn coarser, once */
  const coarser = (mean) => { if (mean > BUDGET) { scale = Math.max(0.5, Math.sqrt(BUDGET / mean)); resize(); wake(); } };
  const at = () => Math.round(px * 100) / 100;
  /* a weight: made (weight, above), or already made under the first light's ring (compileDoor) */
  const compile = (slab) => weight(slab, since);
  /* the first measure, of the first frame, unseen, and the decision, before anything is shown. The rich alone: measured;
     kept, coarser if it must be (&rich: kept whatever); only if even at the coarsest it is over the budget, the lean
     one made and drawn instead (fell). The lean alone: measured, coarser if it must be. Both: the lean measured; with
     room, the rich weight is to be tried once the door is shown (up: tryRich); else the lean one, coarser if it must
     be */
  /* (each measure taken once the chores are at rest: quiet) */
  let up = false, fell = false;
  async function prove() {
    await quiet();
    if (mode === "rich") return richLadder();
    let lean;
    try { lean = measure(); } catch { return; /* drawn as it is */ }
    up = mode === "both" && !LEAN() && (RICH() || lean <= ROOM);
    if (!up) coarser(lean);
    note(`door: lean ${Math.round(lean)} ms a frame, drawn at ${at()}×`, since);
  }
  async function richLadder() {
    let mean;
    try { mean = measure(); } catch { return; /* drawn as it is */ }
    coarser(mean);
    if (RICH() || mean <= BUDGET || scale > 0.5) {
      note(`door: rich ${Math.round(mean)} ms a frame, kept${RICH() ? " (&rich)" : ""}, drawn at ${at()}×`, since);
      return;
    }
    /* at the coarsest: measured again there, and only if it is still over, the lean one */
    await quiet();
    let floor = Infinity;
    try { floor = measure(); } catch { /* as over */ }
    if (floor <= BUDGET) { note(`door: rich ${Math.round(mean)} ms a frame, kept, drawn at ${at()}× (${Math.round(floor)} ms)`, since); return; }
    note(`door: rich ${Math.round(floor)} ms a frame even at ${at()}×, over ${BUDGET}: the lean one made instead`, since);
    try {
      prog = await compile(false);
      fell = true; dirty = true;
    } catch (e) { console.warn("orbit: the door stays rich", e); }
  }
  /* then shown: the frame as the measure left it (drawn again if it was made coarser), the picture let go, and the
     flight told to take up this Earth (voyage.js: followDoor; rich from the first, wantRich: the flight draws the same) */
  function show() {
    if (dirty) draw();
    requestAnimationFrame(() => world.classList.add("live"));
    if (mode === "rich") { state.rich = !fell; wantRich(); }
    followDoor(state);
    seen = true;
    note(`door: live (${mode === "rich" && !fell ? "rich" : "lean"})${fell ? ", the fallback" : ""}`, since);
    wake();
  }
  /* both, with room: once the lean door is shown, the rich weight made (its fields and glow with it), measured and
     kept if it keeps to the budget, the flight then asked for the same; else the lean one stays */
  /* (the try is measured unseen, into a target of its own, so the rich frame is never shown before it is kept; and
     the world planets wait for its decision too: doorMeasured, so the measure is the door's alone) */
  function tryRich() {
    if (!up) { measuredNow(); return; }
    /* (not waited for here: its chores come after this one) */
    compile(true)
      .then((p) => chore(() => { rich = p; richMaps(); return p; }, 60, "rich"))
      .then((rich) => quiet().then(() => {
        const was = prog;
        prog = rich;
        let mean = Infinity;
        try { mean = measure(true); } catch { /* not kept */ }
        if (RICH() || mean <= BUDGET) {
          coarser(mean);
          state.rich = true; wantRich(); dirty = true; wake();
          note(`door: live (rich) ${Math.round(mean)} ms a frame${mean > BUDGET ? `, drawn at ${at()}×` : ""}`, since);
        } else {
          prog = was;
          note(`door: rich ${Math.round(mean)} ms a frame, over ${BUDGET}: stays lean`, since);
        }
      }))
      .catch((e) => { console.warn("orbit: the door stays lean", e); })
      .finally(measuredNow);
  }

  /* made in turn, after the door's reveal (and the probe: the weights chosen, capability.js): the first weight, then
     each map; with the rich one, its fields and glow; the first whole frame drawn, unseen, measured and decided on
     (prove), and only then shown (show); then, with both, the rich tried, unseen; the world planets may start once that
     is decided (doorMeasured) */
  const ready = probe()
    .then(() => {
      mode = theDoorWeight();
      const first = compile(mode === "rich");
      /* the rich weight with "both", where compiles freeze the page: already made at the page's start (compileDoor; kept
         only if the ladder keeps it), so its fields are made with their maps; elsewhere when the ladder asks */
      if (mode === "both" && !compilesAside()) compile(true).then((p) => { rich = p; }, () => { /* the ladder says so, if it gets that far */ });
      return first;
    })
    .then((p) => { prog = p; if (mode === "rich") rich = p; })
    .then(() => Promise.all(keys.map(load)))
    /* the sharper strip, once the small one is in (sharpStrip): put on the GPU beside it, and drawn from then on */
    .then(() => { if (maps.lightsS) stripS.ready((bm) => { maps.lightsS2 = upload("lightsS", bm); dirty = true; wake(); }); else stripS.fail(); })
    /* the rich weight's fields (those not made with their maps) and the cities' glow, before its first frame */
    .then(() => mode === "rich" && chore(richMaps, 60, "door"))
    /* the first frame, on the page but unseen (site.css: canvas.live, until .world.live) */
    .then(() => chore(() => {
      world.querySelector(".wl.earth")?.after(canvas);
      resize(); draw();
    }, 60, "door"))
    .then(prove)
    .then(show)
    .then(tryRich)
    .catch((e) => { console.warn("orbit: the door stays a picture", e); canvas.remove(); stripS.fail(); measuredNow(); });
  addEventListener("resize", () => { if (prog) { resize(); wake(); } });
  document.addEventListener("visibilitychange", wake);
  /* the door coming back (its class or its hidden flag changing) starts the clock again */
  if (door) new MutationObserver(wake).observe(door, { attributes: true, attributeFilter: ["class", "hidden"] });
  new MutationObserver(wake).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return { ready, state, wake };
}
