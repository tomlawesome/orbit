/*
 * The flight's world, drawn in WebGL2 beneath the flight's own canvas
 * (engine.js), which keeps the traffic, the endings and the mark on top.
 *
 * Here: the Earth the door shows (tools/dawn.py) as a globe that falls away —
 * the same camera, 800 km over the Atlantic facing the sunrise, projected onto
 * whatever circle the flight gives the world each frame, so it moves exactly
 * as the flight's world does while its shading stays true: the cities on the
 * night side, the air lit along the limb, the sunlit crescent opening as the
 * camera climbs. Behind it, the fine stars
 * (on the docs' flight, a galaxy in three dimensions is where it goes: seen
 * from outside, dived into, and rested in, its band across the sky as the
 * docs page shows it, the constellations lighting on it);
 * in front, the streaks of the climb, light in depth layers about the way
 * ahead; at the end, the star the flight arrives at. Then the film: bloom,
 * the door's own tone curve, grain.
 *
 * Imagery: NASA's Black Marble (city lights) and Blue Marble (land, clouds),
 * NASA Earth Observatory. Reduced to small maps for here (img/flight in this folder).
 */

import { chore, fetchOnce, note, linked, counted, compilesAside } from "./chores.js";
import { image, flag } from "./settings.js";
import { uploadBanded } from "./upload.js";
import { theDoorWeight, liveDoor } from "./capability.js";

/* the pictures, where the host says they are (settings.js: image), resolved once they are first wanted, never at load */
let textures = null;
export function pictures() {
  return textures || (textures = {
    lights: image("flight/earth-lights.webp"), day: image("flight/earth-day.webp"), clouds: image("flight/earth-clouds.webp"),
    euro: image("flight/europe-lights.webp"), moon: image("flight/moon.webp"),
    /* finer, about where the door looks (NEAR) */
    lightsN: image("dawn/lights-near.webp"), cloudsN: image("dawn/clouds-near.webp"), dayN: image("dawn/land-near.webp"),
  });
}
/* the live door, while it is tried (?door3d: the host's flag): engine.js waits for the probe under it. Only
   where the door is live here (capability.js: liveDoor, the flag and level 1 or 2) is the strip below drawn */
export const DOOR3D = () => !!flag("door3d");
/* the sharpest lights, the 500 m Black Marble over the door's own ground (tools/doorcrop.py), at the sharpness the
   device can show: its band's width in device pixels (D) picks one of three, so a small screen fetches 0.6 MB, not 1.8 */
export function lightsStrip(W, dpr) {
  const D = W * Math.min(dpr, 2), ppd = D < 1600 ? 120 : D < 2600 ? 180 : 240;
  return { url: image(`dawn/lights-strip-${ppd}.webp`), box: [0, 20, 40, 56], ppd };
}
/* chosen once a page view, by whichever (the door or the flight) loads its maps first, and kept: the two draw the same
   strip, so the click's handoff from one to the other does not change the cities */
let strip = null;
export function theStrip() {
  /* (what is loaded first is the smallest, whatever the device's: sharpStrip, below) */
  if (!strip) { strip = lightsStrip(innerWidth, devicePixelRatio || 1); pictures().lightsS = strip0(); }
  return strip;
}
/* the strip comes small first (120 px a degree, 0.6 MB: all the flight waits for), and the device's own (theStrip),
   if it is sharper, after everything else (the last chore, "rich"): put on the GPU in every context drawing the strip
   (the door's, the flight's) in the one chore, and faded in over a second in each by the same clock (uStripMix), so the
   door and the flight never show two sharpnesses at once. The box is the same for every tier.
   sharpStrip(): a context that will draw it says so as it is made, then ready(take) once its small one is on the GPU
   (take(bitmap): the sharp one put on its GPU, kept beside the small one), or fail() if it never will be; the sharp one
   is put on the GPU once every context that said so has said which. Its mix(): 0 → 1 over the fade, from the chore */
const strip0 = () => image("dawn/lights-strip-120.webp"), FADE = 1000;
const sharp = { wants: new Set(), busy: false };
export function sharpStrip() {
  const me = { settled: false, take: null, served: false, at: 0 };
  const settle = (take) => { if (me.settled) return; me.settled = true; me.take = take; sharpen(); };
  if (theStrip().url === strip0()) return { ready() {}, fail() {}, mix: () => 0 };
  sharp.wants.add(me);
  return { ready: settle, fail: () => settle(null), mix: () => (me.at ? Math.min(1, (performance.now() - me.at) / FADE) : 0) };
}
function sharpen() {
  const all = [...sharp.wants];
  if (sharp.busy || all.some((w) => !w.settled)) return;
  const todo = all.filter((w) => w.take && !w.served);
  if (!todo.length) return;
  sharp.busy = true;
  for (const w of todo) w.served = true;
  fetchOnce(strip.url)
    .then((b) => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bm) => chore(() => {
      for (const w of todo) { try { w.take(bm); } catch (e) { console.warn("orbit: the strip stays small", e); } }
      /* the fade's start, the same moment for all of them */
      const at = performance.now();
      for (const w of todo) w.at = at;
      bm.close?.();
      note(`strip: ${strip.ppd} px a degree in, fading over ${FADE / 1000} s`);
    }, 60, "rich"))
    .catch((e) => console.warn("orbit: the strip stays small", e))
    /* a context that said so meanwhile is given it in a chore of its own */
    .finally(() => { sharp.busy = false; sharpen(); });
}
/** start the flight's pictures down the wire, before its world is made (that is a chore; the network is not) */
export function fetchVoyage() { for (const url of Object.values(pictures())) fetchOnce(url).catch(() => {}); }
/* the Europe lights cover lon 2..24, lat 38..55: the door's own view, sharper */
export const EURO = [2, 24, 38, 55];
/* the near maps (lights, clouds, land) cover lon -25..45, lat 28..66: all the door's ground can turn to in a while */
export const NEAR = [-25, 45, 28, 66];
/* the maps that cover a box, not the whole Earth: they do not wrap */
export const BOXED = ["euro", "lightsN", "cloudsN", "dayN", "lightsS"];
const ID3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/* the sun's light through the air, as tools/dawn.py tables it: from a height (0..110 km, finer low down) under the
   sun's elevation there (-12..90 degrees, finest about the horizon, where it changes fastest), the air the light
   crosses on its way in, as three columns (molecules, haze, ozone; Earth radii), which the shader turns into colour.
   Where the Earth is in the way, more air than any light gets through. Made once, for the door and the flight both */
let sunTab = null;
export function sunTable() {
  if (sunTab) return sunTab;
  const NE = 210, NH = 64, N = 48, R = 6371, TOP = 110, RA = R + TOP, out = new Float32Array(NE * NH * 4);
  for (let j = 0; j < NH; j++) {
    const h = TOP * (j / (NH - 1)) ** 2, r0 = R + h;
    for (let i = 0; i < NE; i++) {
      const e = i < 20 ? -12 + i * 0.5 : i < 180 ? -2 + (i - 20) * 0.05 : 6 + ((i - 180) * 84) / 29;
      const mu = Math.sin((e * Math.PI) / 180), b = r0 * mu, o = (j * NE + i) * 4;
      if (mu < 0 && b * b - (r0 * r0 - R * R) > 0) { out[o] = out[o + 1] = out[o + 2] = 1; continue; }
      const top = -b + Math.sqrt(Math.max(b * b - (r0 * r0 - RA * RA), 0)), dt = top / N;
      let cr = 0, cm = 0, co = 0;
      for (let k = 0; k < N; k++) {
        const t = (k + 0.5) * dt, z = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * mu) - R;
        cr += Math.exp(-z / 8); cm += Math.exp(-z / 1.2); co += Math.max(0, 1 - Math.abs(z - 25) / 15);
      }
      out[o] = (cr * dt) / R; out[o + 1] = (cm * dt) / R; out[o + 2] = (co * dt) / R;
    }
  }
  return (sunTab = { w: NE, h: NH, data: out });
}
/** the table as a texture on a context (half floats, which every WebGL2 filters) */
export function sunTexture(gl) {
  const { w, h, data } = sunTable(), t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const VERT = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

/* the whole Earth, as a box (the fields' and the glow's) */
const WORLD = [-180, 180, -90, 90];
/* one of the RICH Earth's two passes (PARTS.passes: uPass 1, the clouds' field; 2, the cities' glow), drawn by the rich
   program itself (prog: { p, u }, finished) into a texture of its own (RGBA8; levels made after, if asked), the context
   left as the draws expect it, uPass back to 0 */
function passInto(gl, prog, mode, w, h, { repeat = false, levels = false } = {}, setup) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  /* (not left bound: the rich program reads maps on every unit, and the texture drawn into must not be one of them) */
  gl.bindTexture(gl.TEXTURE_2D, null);
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, w, h);
  gl.useProgram(prog.p); gl.bindVertexArray(null); gl.uniform1i(prog.u.uPass, mode); setup(prog.u); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.uniform1i(prog.u.uPass, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f);
  if (levels) {
    gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }
  return t;
}
/** the slab's field of a clouds map (its texture, its size; the whole Earth's, which wraps, or the near box's), drawn
    by a rich program (prog: { p, u }) */
export function cloudField(gl, prog, src, w, h, near) {
  return passInto(gl, prog, 1, w, h, { repeat: !near, levels: true }, (u) => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(u.uSrc, 0); gl.uniform4f(u.uBox, ...(near ? NEAR : WORLD));
  });
}
/** the cities' glow, from the lights there are (the whole Earth's map, its size; the near box's, if it has come), drawn
    by a rich program (prog: { p, u }) */
export function cityGlow(gl, prog, lights, w, h, lightsN, blank) {
  const gw = Math.max(1, Math.round(w / 8)), gh = Math.max(1, Math.round(h / 8));
  return passInto(gl, prog, 2, gw, gh, { repeat: true }, (u) => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, lights || blank);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lightsN || blank);
    gl.uniform1i(u.uLights, 0); gl.uniform1i(u.uLightsN, 1);
    gl.uniform4f(u.uNearBox, ...NEAR); gl.uniform4f(u.uHasN, lightsN ? 1 : 0, 0, 0, 0);
    gl.uniform2f(u.uOut, gw, gh);
  });
}

/* the scene's uniforms, each with the part of the scene that reads it (a door-only Earth declares only its own; the
   flight declares them all, in the order they always came in, so its source is what it was). uEarthA rides on
   the Earth's lines, as it always did: declared, and unread by the door, it costs it nothing */
const UNIFORMS = [
  ["common", `uniform vec2 uRes; uniform float uPx, uTime;
/* which of the RICH programs' passes is drawn in place of the scene (0: none; PARTS.passes) */
uniform int uPass;`],
  ["streaks", `uniform vec2 uVP; uniform float uSpeed, uRmax; uniform vec4 uOff, uLen; uniform vec3 uTint;`],
  ["earth", `uniform vec3 uCirc; uniform float uEarthA, uD; uniform mat3 uB; uniform vec3 uSun; uniform vec4 uHas;
/* the ground turned under the camera, and the clouds drifting over it (the live door, door3d.js; still in a flight) */
uniform mat3 uSpinM; uniform float uCloudOff, uAirK;
uniform sampler2D uLights, uDay, uClouds, uEuro; uniform vec4 uEuroBox;
/* the finer maps about where the door looks (lights, clouds, land: which are there, uHasN), the box they cover; the
   cloud slab's strength (0: none) */
uniform sampler2D uLightsN, uCloudsN, uDayN; uniform vec4 uNearBox, uHasN; uniform float uCloudK;
/* the slab's fields, one a clouds map (global, near: cloudField), and the cities' glow (cityGlow); RICH only */
uniform sampler2D uCloudF, uCloudFN, uGlow;
/* the sharpest lights, over the door's own ground (lightsStrip; ?door3d only): the box they cover, and whether they
   are there */
uniform sampler2D uLightsS; uniform vec4 uStripBox; uniform float uHasS;
/* and the sharper strip fading in over it (sharpStrip): how far */
uniform sampler2D uLightsS2; uniform float uStripMix;
/* the sun's light through the air (sunTable) */
uniform sampler2D uSunT;`],
  ["sky", `uniform mat3 uSkyM; uniform float uStarA, uDens;`],
  ["arrival", `uniform float uBloom, uPre; uniform vec2 uBloomPt;`],
  ["moon", `uniform vec4 uMoonS; uniform vec2 uMoonV; uniform float uMoonSpin; uniform sampler2D uMoonT;`],
  ["nebula", `uniform float uNeb, uNebOff;`],
  ["galaxy", `/* the docs' flight: the 3D galaxy, drawn beforehand at half size (GAL), its share of the sky, and how far it has come
   to the docs page's own view (dimmer down the middle, where the words go) */
uniform sampler2D uGalTex; uniform float uG3, uGalPage; uniform mat3 uGCamR;`],
  ["ignite", `/* the docs' constellations igniting at the end: x, y, size, intensity; and their colours */
uniform vec4 uCS[64]; uniform vec3 uCC[64]; uniform int uCN;`],
];
/* the scene's functions, in parts: common (the output, the hashes, the noise), sky (the stars), ignite (the docs'
   constellations), streaks, earth (the air and its sun table, the ground and its tiers of maps, the slab, the limb:
   all the live door draws), nebula, moon, arrival (the star at the end), shock. The flight's programs take them all,
   in this order; the door's (door3d.js), common and earth alone: its compile grew with the whole flight's code, which
   it never ran (Firefox: 0.37 to 1.0 s for the lean one) */
const PARTS = {
  common: `out vec4 o;
const float PI=3.14159265, TAU=6.2831853;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float hash12(vec2 p){return hash13(vec3(p,7.31));}
float vnoise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm3(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }

`,
  sky: `/* ── the sky ── */
vec3 stars(vec3 d,float f){
  vec3 c=vec3(0.0); float pxA=1.0/f;
  for(int i=0;i<3;i++){
    float fi=float(i), sc=(i==0?24.0:i==1?80.0:240.0);
    vec3 g=d*sc, id=floor(g);
    float h1=hash13(id+fi*31.0), h2=hash13(id.yzx+fi*17.0+5.0), h3=hash13(id.zxy+fi*13.0+11.0);
    vec3 sp=normalize((id+0.3+0.4*vec3(h1,h2,hash13(id+7.0+fi)))/sc);
    float px=acos(clamp(dot(d,sp),-1.0,1.0))/pxA;
    float base=i==0?0.6:i==1?0.55:0.45;
    float keep=step(mix(i==0?0.82:0.97,base,uDens),h3);
    float m=(i==0?0.6+pow(h1,3.0)*6.0:i==1?0.25+pow(h2,3.0)*1.5:0.08+0.3*h2)*keep;
    float tint=fract(h1*13.7+h2*7.1);
    vec3 col=tint<0.25?vec3(0.66,0.76,1.0):tint<0.6?vec3(1.0,0.97,0.94):tint<0.85?vec3(1.0,0.87,0.7):vec3(1.0,0.7,0.52);
    c+=col*m*exp(-px*px*1.6);
  }
  return c;
}
vec3 sky(vec2 css){
  float f=uRes.y/uPx*0.95;
  vec3 d=normalize(vec3((css.x-uRes.x/uPx*0.5)/f,(uRes.y/uPx*0.5-css.y)/f,1.0));
  vec3 s=uSkyM*d;
  /* the night itself: black, with only the faintest warmth of the galaxy's own light */
  vec3 c=vec3(0.0011,0.0010,0.0010);
  c+=stars(s,f*uPx)*0.16*uStarA;
  return c;
}
`,
  ignite: `/* the docs' constellations, lit one by one: each star a hot white core in its figure's colour, a glow round it,
   the brightest with a fine cross; flaring as it lights and settling to the page's own */
vec3 ignite(vec2 css){
  vec3 acc=vec3(0.0); float H=uRes.y/uPx, reach=H*0.14;
  for(int i=0;i<64;i++){
    if(i>=uCN) break;
    vec4 st=uCS[i]; if(st.w<=0.001) continue;
    vec2 d=css-st.xy; float r2=dot(d,d); if(r2>reach*reach) continue;
    float r=sqrt(r2), sz=st.z, win=1.0-smoothstep(reach*0.5,reach,r);
    vec3 col=uCC[i];
    float core=exp(-r2/(sz*sz*1.1));
    float halo=exp(-r/(sz*4.0))*0.22+exp(-r/(sz*12.0))*0.012;
    float spk=sz>2.6?(exp(-abs(d.y)/0.55)*exp(-abs(d.x)/(sz*8.0))+exp(-abs(d.x)/0.55)*exp(-abs(d.y)/(sz*8.0)))*0.3:0.0;
    acc+=(mix(vec3(1.0),col,0.3)*core*5.0+col*(halo+spk)*2.2)*st.w*win;
  }
  return acc;
}

`,
  streaks: `/* ── the streaks: light passing, in four depths, each a ring of lanes about the way ahead ── */
vec3 streaks(vec2 css){
  vec2 p=css-uVP; float r=length(p); if(r<6.0) return vec3(0.0);
  float a=atan(p.y,p.x), u=log(r);
  vec3 acc=vec3(0.0);
  for(int i=0;i<4;i++){
    float z=0.35+0.22*float(i);
    float N=floor(520.0+520.0*float(i));
    float sct=a/TAU*N, s0=floor(sct);
    float du=0.62, off=uOff[i], len=uLen[i];
    for(int k=0;k<2;k++){
      float s=s0+float(k)-(fract(sct)<0.5?1.0:0.0);
      float hs=hash12(vec2(s,float(i)*7.0));
      float aj=(s+0.5+0.6*(hash12(vec2(s,3.1+float(i)))-0.5))/N*TAU;
      float da=a-aj; da=mod(da+PI,TAU)-PI;
      float perp=abs(da)*r;
      float near=clamp(r/uRmax,0.0,1.0);
      float w=(0.45+1.5*near*z)/uPx*uPx;
      if(perp>w*4.0) continue;
      float uu=u-off-hs*du; float cell=floor(uu/du);
      for(int j=0;j<2;j++){
        float cj=cell+float(j);
        float hc=hash13(vec3(s,cj,float(i)));
        if(hc>0.15*mix(0.12,1.0,uDens)) continue;
        float head=off+hs*du+(cj+hash13(vec3(cj,s,9.0+float(i))))*du;
        float L=max(len,w*1.2/r);
        float along=(u-(head-L))/L;
        if(along<0.0||along>1.0+w/(r*L)) continue;
        float tail=pow(clamp(along,0.0,1.0),1.6);
        float core=exp(-perp*perp/(w*w));
        float tcol=hash13(vec3(s,cj,4.0));
        vec3 col=tcol<0.07?uTint:tcol<0.35?vec3(0.72,0.8,1.0):tcol<0.85?vec3(1.0,0.97,0.93):vec3(1.0,0.86,0.7);
        float hb=hash13(vec3(cj,s,17.0+float(i)));
        float bright=(0.2+1.4*near)*(0.35+0.65*z)*(0.25+2.2*hb*hb*hb*hb);
        col*=mix(vec3(1.18,0.92,0.72),vec3(0.86,0.97,1.2),clamp(along,0.0,1.0)*0.85+0.15);
        acc+=col*core*tail*bright*smoothstep(10.0,60.0,r);
      }
    }
  }
  return acc;
}

`,
  earth: `/* ── the Earth (tools/dawn.py, its picture the measure of this: the same air, clouds, ground and lights) ── */
const vec3 BR=vec3(36.95,86.38,210.9);      /* Rayleigh, per Earth radius */
const float HR=8.0/6371.0, BM=25.46, BMX=28.0, HM=1.2/6371.0, RA=1.0+100.0/6371.0;
const vec3 BO=vec3(0.650,1.881,0.085)*6371.0e-3*0.6;
const vec3 SUNL=vec3(1.0,0.96,0.90)*20.0;
/* a quarter moon high behind the camera: what shows the night's clouds and land */
const vec3 MOONL=vec3(0.55,0.62,0.78)*0.0045;
/* the cloud slab (km): its foot and its tallest tops (dawn.py's CL0, CL1), and the low air it stands in, which a ray
   is marched through finely, the clouds with it */
const float KM=1.0/6371.0, CL0=1.0, CL1=11.0, LOW=15.0;
/* the sun's light reaching a height (Earth radii) under the sun's elevation there (its sine): read from the table
   of the air it crosses (sunTable, below; the Earth in the way, none) */
vec3 sunT(float hh,float mu){
  float e=clamp(degrees(asin(clamp(mu,-1.0,1.0))),-12.0,90.0);
  float i=e<-2.0?(e+12.0)*2.0:e<6.0?20.0+(e+2.0)*20.0:180.0+(e-6.0)*(29.0/84.0);
  float k=sqrt(clamp(hh*(6371.0/110.0),0.0,1.0))*63.0;
  vec3 c=textureLod(uSunT,vec2((i+0.5)/210.0,(k+0.5)/64.0),0.0).rgb;
  return exp(-(BR*c.r+BMX*c.g+BO*c.b));
}
vec2 sph(vec3 ro,vec3 rd,float R){ float b=dot(ro,rd), c=dot(ro,ro)-R*R, d=b*b-c; if(d<0.0) return vec2(-1.0); d=sqrt(d); return vec2(-b-d,-b+d); }
float hg(float c,float g){ return (1.0-g*g)/(4.0*PI*pow(1.0+g*g-2.0*g*c,1.5)); }

/* the maps come in tiers: the whole Earth; a box about where the door looks, finer (uNearBox: lon0, lon1, lat0, lat1);
   and, for the lights, Europe, finer (uEuroBox), then the door's own ground, finest (uStripBox). Each box's map takes over from the one beneath across a margin
   inside its edges (degrees), so no seam shows as the ground turns. g is (lon, lat) in degrees */
const vec4 WORLD=vec4(-180.0,180.0,-90.0,90.0);
float inBox(vec2 g,vec4 b,float m){ return smoothstep(0.0,m,min(min(g.x-b.x,b.y-g.x),min(g.y-b.z,b.w-g.y))); }
vec2 boxUV(vec2 g,vec4 b){ return vec2((g.x-b.x)/(b.y-b.x),(b.w-g.y)/(b.w-b.z)); }
vec2 boxD(vec2 d,vec4 b){ return vec2(d.x/(b.y-b.x),-d.y/(b.w-b.z)); }
/* the level of a map that blurs it by about deg degrees */
float lodAt(sampler2D t,vec4 b,float deg){ return log2(max(deg*float(textureSize(t,0).x)/(b.y-b.x),1.0)); }
/* the lights and the land on the ground, read over the pixel's footprint there (ga, gb: its two axes, degrees): the
   anisotropic filter gathers along the long one; the level comes from the short one, so the cities seen almost edge
   on stay points, as the picture's are, and do not blur into the coarse levels */
/* a map read where it is seen larger than its texels: each texel kept crisp to within a pixel at its edges, not
   smeared over the pixels between (the lights' map is coarser than the picture's, which reads a finer one point by
   point); where it is seen smaller, as it is */
vec3 crisp(sampler2D t,vec2 uv,vec2 ga,vec2 gb){
  vec2 sz=vec2(textureSize(t,0)), m=1.0/max(max(abs(ga),abs(gb))*sz,vec2(1e-4));
  vec2 p=uv*sz-0.5, f=clamp((fract(p)-0.5)*max(m,1.0)+0.5,0.0,1.0);
  return textureGrad(t,(floor(p)+f+0.5)/sz,ga,gb).rgb;
}
vec3 lightsAt(vec2 g,vec2 ga,vec2 gb){
  float wS=uHasS>0.5?inBox(g,uStripBox,1.0):0.0;
  float wE=uHas.y>0.5?inBox(g,uEuroBox,1.0):0.0, wN=uHasN.x>0.5?inBox(g,uNearBox,2.0):0.0;
  vec3 c=vec3(0.0);
  if(wS<1.0){
    if(wE<1.0){
      if(wN<1.0&&uHas.x>0.5) c=textureGrad(uLights,boxUV(g,WORLD),boxD(ga,WORLD),boxD(gb,WORLD)).rgb;
      if(wN>0.0) c=mix(c,crisp(uLightsN,boxUV(g,uNearBox),boxD(ga,uNearBox),boxD(gb,uNearBox)),wN);
    }
    if(wE>0.0) c=mix(c,crisp(uEuro,boxUV(g,uEuroBox),boxD(ga,uEuroBox),boxD(gb,uEuroBox)),wE);
  }
  if(wS>0.0){
    vec3 cs=crisp(uLightsS,boxUV(g,uStripBox),boxD(ga,uStripBox),boxD(gb,uStripBox));
    if(uStripMix>0.0) cs=mix(cs,crisp(uLightsS2,boxUV(g,uStripBox),boxD(ga,uStripBox),boxD(gb,uStripBox)),uStripMix);
    c=mix(c,cs,wS);
  }
  return pow(c,vec3(2.2));
}
vec3 landAt(vec2 g,vec2 ga,vec2 gb){
  if(uHas.z<0.5) return vec3(0.004,0.005,0.01);
  float wN=uHasN.z>0.5?inBox(g,uNearBox,2.0):0.0;
  vec3 c=vec3(0.0);
  if(wN<1.0) c=textureGrad(uDay,boxUV(g,WORLD),boxD(ga,WORLD),boxD(gb,WORLD)).rgb;
  if(wN>0.0) c=mix(c,textureGrad(uDayN,boxUV(g,uNearBox),boxD(ga,uNearBox),boxD(gb,uNearBox)).rgb,wN);
  return pow(c,vec3(2.2));
}
#ifdef SLAB
/* the city lights' glow on the undersides of the clouds over them: the lights blurred (dawn.py: GLOW), made once a
   context (cityGlow) and read here once a step, where there is cloud. Kept as the maps keep it, before its 2.2 curve:
   the averaging loses the bright points' share, given back where it is used (measured against dawn.py's own) */
vec3 glowAt(vec2 g){ return pow(textureLod(uGlow,boxUV(g,WORLD),0.0).rgb,vec3(2.2)); }
/* the slab where a step of the march is (the clouds drifting over the ground), from the field made once a clouds map
   (cloudField), read at the step's own footprint (fd, degrees): the cover (x) and the cover softened (y), each remapped
   as dawn.py does, and how high the tops stand (z, km). One texel a step; two only across the near box's margin */
const float TOPS=CL1+2.6-CL0;
vec3 slabAt(vec2 g,float fd){
  g.x=mod(g.x+uCloudOff*360.0+180.0,360.0)-180.0;
  float wN=uHasN.y>0.5?inBox(g,uNearBox,2.0):0.0;
  vec3 f=vec3(0.0);
  if(wN<1.0) f=textureLod(uCloudF,boxUV(g,WORLD),lodAt(uCloudF,WORLD,fd)).rgb;
  if(wN>0.0) f=mix(f,textureLod(uCloudFN,boxUV(g,uNearBox),lodAt(uCloudFN,uNearBox,fd)).rgb,wN);
  return vec3(f.xy,CL0+f.z*TOPS);
}
#else
/* LEAN: the cloud cover on the ground itself (drifting over it), read over the pixel's footprint as the land is */
float coverAt(vec2 g,vec2 ga,vec2 gb){
  if(uCloudK<=0.0) return 0.0;
  g.x=mod(g.x+uCloudOff*360.0+180.0,360.0)-180.0;
  float wN=uHasN.y>0.5?inBox(g,uNearBox,2.0):0.0, c=0.0;
  if(wN<1.0) c=textureGrad(uClouds,boxUV(g,WORLD),boxD(ga,WORLD),boxD(gb,WORLD)).r;
  if(wN>0.0) c=mix(c,textureGrad(uCloudsN,boxUV(g,uNearBox),boxD(ga,uNearBox),boxD(gb,uNearBox)).r,wN);
  return c;
}
#endif
/* (lon, lat) in degrees of a point on the turned ground, and its east and north there */
vec2 lonlat(vec3 Q){ return degrees(vec2(atan(Q.y,Q.x),asin(clamp(Q.z,-1.0,1.0)))); }

/* the ground: the cities, and the land as the twilight sky and the moon show it (dawn.py's ground, exactly); by day,
   as the flight climbs into the sunlit crescent, the sun on it too, through the air above, and the cities fade */
vec3 surface(vec3 P,vec3 rd,float w){
  vec3 Q=uSpinM*P;
  vec2 g=lonlat(Q);
  /* the pixel's footprint (w: its width at this distance, Earth radii), as degrees of (lon, lat), turned with the
     ground: its width across the line of sight, on both axes. Along it the ground is seen slantwise and the footprint
     is longer, but read so (and gathered by the anisotropic filter) the cities smear down the screen; the
     picture reads them point by point, and so is this, as sharp */
  vec3 ac=normalize(cross(rd,P)), al=normalize(rd-dot(rd,P)*P);
  float k=1.0;
  vec3 E=normalize(vec3(-Q.y,Q.x,0.0)+vec3(1e-6,0.0,0.0)), N=cross(Q,E);
  float cl=max(length(Q.xy),0.01);
  vec3 a=uSpinM*ac*w, b=uSpinM*al*w*k;
  vec2 ga=degrees(vec2(dot(a,E)/cl,dot(a,N))), gb=degrees(vec2(dot(b,E)/cl,dot(b,N)));
  float mu=dot(P,uSun), es=degrees(asin(clamp(mu,-1.0,1.0)));
  float tw=exp(-abs(max(es,-30.0))/2.0);
  vec3 sky=vec3(0.25,0.35,0.7)*0.35*tw+vec3(1.0,0.55,0.3)*0.6*tw*tw*tw+MOONL*4.0;
  vec3 sun=SUNL*0.4*sunT(0.0,mu)*max(mu,0.0)/PI;
  vec3 c=landAt(g,ga,gb)*(sky+sun), li=lightsAt(g,ga,gb)*0.9*(1.0-smoothstep(0.0,0.12,mu));
#ifndef SLAB
  /* LEAN: the clouds a flat cover over the ground, lit as the ground is (as the Earth was before the slab), and the
     cities under them dimmed */
  float ca=smoothstep(0.22,0.85,coverAt(g,ga,gb));
  c=mix(c,vec3(0.85)*(sky+sun),ca); li*=1.0-0.8*ca;
#endif
  return li+c;
}
/* the air at a point of the march: its light toward the camera (the sun's, scattered; the rest of the lit sky's, a
   little, blue; and the airglow, oxygen's faint green in a thin shell 95 km up) and its extinction; and the sun's light
   reaching it (Ts) */
vec3 airAt(vec3 x,float pr,float pm,out vec3 ext,out vec3 Ts){
  float r=length(x), hh=r-1.0, hk=hh*6371.0, ms=dot(x/r,uSun);
  float dr=exp(-hh/HR), dm=exp(-hh/HM), dz=max(0.0,1.0-abs(hk-25.0)/15.0);
  ext=BR*dr+BMX*dm+BO*dz;
  Ts=sunT(hh,ms);
  return ((BR*dr*pr+BM*dm*pm)*Ts*SUNL+BR*dr*SUNL*0.012*exp(min(ms,0.0)*38.0)
          +vec3(0.35,1.0,0.45)*(0.7e-4*6371.0)*exp(-0.5*pow((hk-95.0)/2.2,2.0)));
}
vec3 earth(vec2 css,out float cover){
  cover=0.0;
  vec2 d=vec2(css.x-uCirc.x,uCirc.y-css.y)/uCirc.z;
  float F=sqrt(uD*uD-1.0);
  vec3 v=vec3(d,F), rd=normalize(uB*v), ro=-uB[2]*uD;
  /* a pixel's width, as an angle */
  float pa=1.0/(uCirc.z*uPx*length(v));
  vec3 L=vec3(0.0), T=vec3(1.0);
  vec2 ta=sph(ro,rd,RA), tg=sph(ro,rd,1.0);
  bool ground=tg.x>0.0;
  float t1=ground?tg.x:ta.y;
  if(ta.y>0.0){
    float t0=max(ta.x,0.0);
#ifdef SLAB
    /* the march, in up to three stretches: down to the low air; through it, finely, the clouds with it (a step every
       8 km or so, as many as 24; for a ray that skims it, missing the ground, a step every 6 km, as many as 64: there
       are few of them, and their clouds are the tops breaking the horizon); and out of it again. A ray that never
       comes so low, or never down among the cloud tops, is marched in one, as coarsely: its air is thin and even. The
       low air has a loop of its own, so the clouds' work is only ever done there */
    vec2 tl=sph(ro,rd,1.0+LOW*KM), tt=sph(ro,rd,1.0+(CL0+TOPS)*KM);
    bool low=tl.y>0.0&&tt.y>0.0;
#else
    /* LEAN: no slab, so no low air of its own: every ray marched in one, as a ray that never comes low is */
    const bool low=false;
    vec2 tl=vec2(0.0);
#endif
    float la=low?max(tl.x,t0):t1, lb=low?(ground?tg.x:tl.y):t1;
    int nA=low?6:16, nB=low?int(clamp(ceil((lb-la)/((ground?8.0:6.0)*KM)),6.0,ground?24.0:64.0)):0, nC=low&&!ground?6:0;
    float j=0.5+0.6*(hash13(vec3(gl_FragCoord.xy,uTime*31.0))-0.5);
    float mv=dot(rd,uSun), pr=3.0/(16.0*PI)*(1.0+mv*mv), pm=hg(mv,0.8);
    /* the air's light over the ground as it is; over the limb, as strong as asked (uAirK: the door's own) */
    float ak=ground?1.0:uAirK;
    /* the high air: on the way down, and out again (kept apart, and laid behind the low air at the end) */
    vec3 LC=vec3(0.0), TC=vec3(1.0);
    for(int i=0;i<22;i++){
      if(i>=nA+nC) break;
      bool back=i>=nA;
      float a0=back?lb:t0, ds=((back?t1:la)-a0)/float(back?nC:nA);
      vec3 x=ro+rd*(a0+ds*(float(back?i-nA:i)+j)), ext, Ts;
      vec3 ins=airAt(x,pr,pm,ext,Ts)*ak;
      vec3 st=exp(-ext*ds), dl=ins*(1.0-st)/max(ext,vec3(1e-6));
      if(back){ LC+=TC*dl; TC*=st; } else { L+=T*dl; T*=st; }
    }
#ifdef SLAB
    /* the low air, and the clouds in it; their own phase mostly forward, a little back */
    vec3 csunK=SUNL*((0.7*hg(mv,0.6)+0.3*hg(mv,-0.2))*4.0*PI*0.08+0.02);
    /* (a skimming ray's steps are where its neighbours' are, not jittered: the tops it finds are then the same from one
       pixel to the next, a clean edge, not a ragged one) */
    float ds=(lb-la)/float(max(nB,1)), jb=ground?j:0.5;
    for(int i=0;i<64;i++){
      if(i>=nB) break;
      float t=la+ds*(float(i)+jb);
      vec3 x=ro+rd*t, ext, Ts;
      vec3 ins=airAt(x,pr,pm,ext,Ts)*ak;
      float r=length(x), hk=(r-1.0)*6371.0;
      /* dawn.py's slab, standing up from the cover as thick as it is dense; nothing more done where there is none */
      if(uCloudK>0.0&&hk>CL0&&hk<CL0+TOPS){
        vec3 up=x/r;
        vec2 g=lonlat(uSpinM*up);
        vec3 f=slabAt(g,degrees(t*pa));
        float c=f.x, cs=f.y, top=f.z;
        if(c>0.0&&top>hk){
          float e=clamp((top-hk)/(0.6+1.6*cs),0.0,1.0);
          float cd=c*e*e*(3.0-2.0*e)*clamp((hk-CL0)/0.6,0.0,1.0)*0.6*6371.0*uCloudK;
          /* lit by the sun through the air (their tops catch it first), by the twilight sky, from below by the
             cities' glow, and by the moon */
          float hn=clamp((hk-CL0)/(CL1-CL0),0.0,1.0), ms=dot(up,uSun);
          vec3 cl=Ts*csunK*(0.35+0.65*hn)
                 +vec3(0.22,0.32,0.6)*0.5*exp(clamp(degrees(asin(clamp(ms,-1.0,1.0))),-20.0,0.0)/2.2)
                 +glowAt(g)*vec3(1.6,1.5,1.3)*0.6*(1.0-hn)*(1.0-hn)
                 +MOONL*(0.5+0.5*hn);
          ins+=cd*cl; ext+=vec3(cd);
        }
      }
      vec3 st=exp(-ext*ds);
      L+=T*ins*(1.0-st)/max(ext,vec3(1e-6)); T*=st;
    }
#endif
    L+=T*LC; T*=TC;
  }
  if(ground){
    vec3 P=ro+rd*tg.x;
    L+=T*surface(P,rd,tg.x*pa);
    /* the edge of the disc, smoothed over a pixel */
    cover=clamp((1.0-length(d))*uCirc.z*uPx+0.5,0.0,1.0);
  }
  /* (the sun itself is the flight's own glow, which matches the door's; this lens would stretch it) */
  return L;
}

/* the Earth, its limb smoothed: the ground is there or it is not, so a pixel the limb crosses is seen twice, its
   ground a little inside the limb and its air a little outside, each taking the share of the pixel it covers (a
   nearly level edge would otherwise step from pixel to pixel); everywhere else, once. One loop, so the Earth is
   compiled once */
vec3 earthAA(vec2 css,out float cover){
  vec2 d=vec2(css.x-uCirc.x,uCirc.y-css.y)/uCirc.z;
  float l=length(d), k=(1.0-l)*uCirc.z*uPx;
  int n=abs(k)<0.5?2:1;
  vec2 nv=vec2(d.x,-d.y)/max(l,1e-6), lim=css-nv*(1.0-l)*uCirc.z;
  vec3 acc=vec3(0.0); float cv=0.0;
  for(int i=0;i<2;i++){
    if(i>=n) break;
    float c; vec3 e=earth(n==1?css:lim+nv*((float(i)-0.5)*0.6/uPx),c);
    float w=n==1?1.0:i==0?k+0.5:0.5-k;
    acc+=e*w; cv+=n==1?c:0.0;
  }
  cover=n==1?cv:k+0.5; return acc;
}

`,
  nebula: `/* ── the passage: a nebula streaming past, two depths of it about the way ahead ── */
vec3 nebula(vec2 css,out float dust){
  dust=0.0; if(uNeb<=0.001) return vec3(0.0);
  vec2 p=css-uVP; float r=length(p), a=atan(p.y,p.x), u=log(max(r,1.0));
  vec3 acc=vec3(0.0);
  for(int i=0;i<2;i++){
    float k=i==0?1.5:3.1, sp=i==0?1.0:0.62;
    vec3 q=vec3(cos(a)*k,sin(a)*k,(u-uNebOff*sp)*k*0.85+float(i)*13.0);
    float f=fbm3(q);
    /* filaments: the gas drawn out in threads; knots where it is densest; lanes of dust between */
    float fil=1.0-abs(2.0*vnoise(q*vec3(2.6,2.6,1.3)+3.0)-1.0); fil=fil*fil*fil;
    float d=smoothstep(0.44,0.82,f)*(0.35+0.65*fil);
    float knot=pow(smoothstep(0.62,0.95,f),3.0);
    float lane=smoothstep(0.5,0.75,vnoise(q*vec3(1.8,1.8,0.9)+11.0))*smoothstep(0.35,0.6,f);
    float hue=vnoise(q*0.45+5.0);
    vec3 col=mix(mix(vec3(0.42,0.16,1.0),vec3(1.0,0.22,0.52),smoothstep(0.3,0.68,hue)),vec3(0.16,0.58,0.86),smoothstep(0.66,0.9,hue));
    float near=smoothstep(40.0,uRmax*0.45,r);
    acc+=(col*d*1.2+vec3(1.0,0.86,0.9)*knot*1.6)*(0.3+0.9*near)*(i==0?1.0:0.55)*(1.0-lane*0.8);
    dust+=(d*0.25+lane*0.55)*near;
  }
  dust=clamp(dust*uNeb,0.0,0.7); return acc*uNeb*1.1;
}

`,
  moon: `/* ── the moon passed on the way out: the install's gold moon, growing as it sweeps by ── */
vec4 moonAt(vec2 css,float lod){
  vec2 d=(css-uMoonS.xy)/uMoonS.z; float rr=dot(d,d); if(rr>1.0) return vec4(0.0);
  vec3 n=vec3(d.x,-d.y,sqrt(1.0-rr));
  float cs=cos(uMoonSpin), sn=sin(uMoonSpin); vec3 m=vec3(cs*n.x+sn*n.z,n.y,-sn*n.x+cs*n.z);
  vec2 uv=vec2(atan(m.x,m.z)/TAU+0.5,0.5-asin(clamp(m.y,-1.0,1.0))/PI);
  vec3 alb=pow(textureLod(uMoonT,uv,lod).rgb,vec3(2.2)); float l=dot(alb,vec3(0.2126,0.7152,0.0722)); alb=mix(vec3(l),alb,0.5);
  vec3 L=normalize(vec3(-0.25,-0.8,-0.15));
  float lit=smoothstep(-0.05,0.25,dot(n,L))*max(dot(n,L),0.0);
  vec3 c=alb*SUNL*lit*0.7+alb*0.006;
  float cov=clamp((1.0-sqrt(rr))*uMoonS.z*uPx+0.5,0.0,1.0);
  return vec4(c*cov,cov);
}
vec4 moon(vec2 css){
  if(uMoonS.w<=0.0||length(css-uMoonS.xy)>uMoonS.z+length(uMoonV)+2.0) return vec4(0.0);
  vec4 acc=vec4(0.0);
  /* its blur over the exposure: twelve fixed steps, so the edges are steady frame to frame. Its map is read at one
     level of detail for the whole disc (its texels across a pixel, at the centre), worked out once here: a read that
     found its own level from its neighbours would have the compiler copy the loop out twelve times over */
  float lod=log2(max(1.0,float(textureSize(uMoonT,0).x)/(TAU*uMoonS.z*uPx)));
  for(int i=0;i<12;i++) acc+=moonAt(css+uMoonV*((float(i)+0.5)/12.0-0.5),lod);
  return acc/12.0*uMoonS.w;
}

`,
  arrival: `/* ── the star at the end: seen ahead as the flight brakes, then blooming ──
   Built as a star is seen through a lens: a limb-darkened photosphere with its granulation and a red chromosphere at
   the rim; a corona of streamers drifting outwards; the ciliary glare, hundreds of hair-fine rays fringed with colour;
   six diffraction spikes, banded along their length, the red reaching furthest; a level anamorphic streak; a faint
   rainbow halo. All of it HDR, so the film's bloom carries it. */
vec3 arrival(vec2 css){
  float e=pow(uBloom,1.2), lum=e+uPre*0.3;
  if(lum<=0.001) return vec3(0.0);
  vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx, Wd=uRes.x/uPx, a=atan(p.y,p.x);
  vec2 dir=r>0.0?p/r:vec2(1.0,0.0);
  float Rd=H*(0.004+0.065*e);                        /* the star's disc */
  vec3 c=vec3(0.0);
  /* the photosphere: limb-darkened, granulated, white-gold at the centre, deeper gold at the limb */
  if(r<Rd){
    float x=r/Rd, mu=sqrt(1.0-x*x);
    /* granules: bright cells parted by darker lanes, the cells foreshortened towards the limb */
    vec2 q=p/(Rd*0.075); q+=(p/max(r,1e-3))*dot(p/max(r,1e-3),q)*(1.0/max(mu,0.25)-1.0)*0.5;
    float g1=1.0-abs(vnoise(vec3(q,uTime*0.5))*2.0-1.0), g2=1.0-abs(vnoise(vec3(q*2.7+7.0,uTime*0.9))*2.0-1.0);
    float gran=smoothstep(0.25,0.95,g1*0.7+g2*0.3);
    float I=(1.0-0.66*(1.0-mu)-0.1*(1.0-mu*mu))*(0.84+0.28*gran);
    /* bright, but held within the film's range, so its surface reads: the cells, the darkening to the limb */
    c+=mix(vec3(1.0,0.46,0.14),vec3(1.0,0.89,0.7),pow(mu,0.6))*I*mix(16.0,4.2,smoothstep(0.0,0.35,e))*lum;
  }
  /* the chromosphere: a thin red rim */
  c+=vec3(1.0,0.4,0.18)*exp(-pow((r-Rd)/(Rd*0.025+0.5),2.0))*mix(3.0,1.2,smoothstep(0.0,0.4,e))*lum;
  /* the corona: streamers in two scales, drifting outwards and turning slowly, white-gold to amber to a faint violet */
  float lr=log(max(r,Rd)/Rd);
  float n1=vnoise(vec3(cos(a)*5.0,sin(a)*5.0,lr*1.4-uTime*0.12)), n2=vnoise(vec3(cos(a)*17.0,sin(a)*17.0,lr*2.6-uTime*0.2+3.0));
  float stream=0.35+1.1*n1*n1+0.55*n2*n2*n2;
  vec3 ccol=mix(mix(vec3(1.0,0.93,0.8),vec3(1.0,0.66,0.32),smoothstep(0.0,1.6,lr)),vec3(0.62,0.42,0.9),smoothstep(1.8,3.6,lr));
  c+=ccol*stream*pow(Rd/max(r,Rd),1.7)*2.6*lum*smoothstep(Rd*0.98,Rd*1.05,r);
  /* the ciliary glare: hair-fine rays of every length about the core, two sets, fringed with colour at their tips */
  for(int k=0;k<2;k++){
    float N=k==0?211.0:137.0, sa=a/TAU*N+float(k)*0.37, id=floor(sa);
    float h1=hash12(vec2(id,float(k)*7.0)), h2=hash12(vec2(id+3.0,float(k)*13.0));
    float perp=abs(fract(sa)-0.5)*(TAU/N)*r;
    float L=H*(0.03+0.32*h1*h1*h1)*(0.35+0.85*e);
    float t=r/L;
    vec3 tip=mix(vec3(0.85,0.92,1.0),vec3(1.0,0.75,0.55),smoothstep(0.3,1.2,t));
    c+=tip*exp(-perp*perp/0.45)*exp(-t*2.2)*smoothstep(Rd*0.6,Rd*1.4,r)*(0.25+h2*1.4)*1.6*lum;
  }
  /* the diffraction spikes: six, banded, dispersed (each colour reaching its own length, the red the furthest) */
  for(int k=0;k<3;k++){
    float an=0.52+float(k)*PI/3.0;
    vec2 ax=vec2(cos(an),sin(an));
    float al=abs(dot(p,ax)), pe=abs(dot(p,vec2(-ax.y,ax.x)));
    float len=H*(0.05+0.24*e), w=0.7+al*0.003;
    vec3 L3=len*vec3(1.0,0.86,0.72);
    vec3 spike=exp(-pow(vec3(al)/L3,vec3(1.6)))*exp(-pe*pe/(w*w));
    float band=0.7+0.3*pow(sin(al/(H*0.012)),2.0);
    c+=spike*band*(1.0-exp(-al/(Rd*2.0+4.0)))*2.4*lum;
  }
  /* and two faint secondary spikes, the support's, square to the rest */
  { vec2 ax=vec2(cos(0.52+PI*0.5/3.0),sin(0.52+PI*0.5/3.0)); float al=abs(dot(p,ax)), pe=abs(dot(p,vec2(-ax.y,ax.x)));
    c+=vec3(0.9,0.92,1.0)*exp(-pow(al/(H*(0.03+0.12*e)),1.6))*exp(-pe*pe/0.5)*0.5*lum; }
  /* the anamorphic streak: a thin hot core and a wide cool veil */
  c+=vec3(0.5,0.68,1.0)*exp(-abs(p.y)/1.2)*exp(-abs(p.x)/(Wd*(0.05+0.42*e)))*1.3*lum;
  c+=vec3(0.32,0.45,1.0)*exp(-abs(p.y)/(H*0.012))*exp(-abs(p.x)/(Wd*(0.08+0.3*e)))*0.22*lum;
  /* a lens halo: a faint ring, each colour at its own radius */
  float rh=H*(0.11+0.12*e);
  c+=vec3(exp(-pow((r-rh*0.965)/(H*0.005),2.0)),exp(-pow((r-rh)/(H*0.005),2.0)),exp(-pow((r-rh*1.035)/(H*0.005),2.0)))*0.14*lum;
  /* the sky takes the light: a wide warm scatter */
  c+=vec3(1.0,0.8,0.52)*exp(-r/(H*0.45))*0.16*lum+vec3(1.0,0.82,0.6)*exp(-max(r-Rd,0.0)/(H*0.05))*0.7*lum*smoothstep(Rd*0.9,Rd*1.1,r);
  return c;
}

`,
  shock: `/* the shockwave of the arrival: a ring running outwards that bends the starlight it crosses */
vec2 shockBend(vec2 css,out float ring){
  ring=0.0; if(uBloom<=0.0||uBloom>=1.0) return css;
  vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx;
  float rs=uBloom*H*1.25, w=H*0.03, fade=1.0-uBloom;
  float g=exp(-pow((r-rs)/w,2.0));
  ring=g*fade;
  return css-(r>0.0?p/r:vec2(0.0))*g*w*0.8*fade*sign(r-rs+0.0001);
}
`,
  passes: `/* ── the RICH Earth's fields, drawn by its own program once a context (uPass 1, 2: cloudField, cityGlow), each into a
   texture of its own, so the slab's march reads one texel a step where it read three ── */
uniform sampler2D uSrc; uniform vec4 uBox; uniform vec2 uOut;
/* the field of a clouds map, at the map's own size: the cover (r) and the cover softened (g: dawn.py blurs its map for
   the height the tops stand to, so masses of cloud rise as masses; here, as the march read it before, the level of the
   map that blurs it by 0.16 degrees), each remapped as dawn.py does; and how high the tops stand (b: km over the slab's
   foot, as a share of the most they can, TOPS) */
vec4 fieldPass(){
  vec4 o;
  vec2 sz=vec2(textureSize(uSrc,0));
  float c=texelFetch(uSrc,ivec2(gl_FragCoord.xy),0).r;
  float s=textureLod(uSrc,gl_FragCoord.xy/sz,log2(max(0.16*sz.x/(uBox.y-uBox.x),1.0))).r;
  c=clamp((c-0.2)/0.8,0.0,1.0); s=clamp((s-0.2)/0.8,0.0,1.0);
  float top=CL0+0.8+(CL1-CL0-0.8)*pow(s,1.1)*(0.55+0.45*c)+1.6*c*c;
  o=vec4(c,s,(top-CL0)/TOPS,1.0);
  return o;
}
/* the cities' glow: the lights as the glow under the clouds took them (the whole Earth's, the near box's over it),
   each read at the level that averages it to a texel here: an eighth of the whole Earth's map, so the march reads it
   once a step, and only where there is cloud. Kept before the 2.2 curve, as the maps are (the near lights there or
   not: uHasN.x) */
vec4 glowPass(){
  vec4 o;
  vec2 uv=gl_FragCoord.xy/uOut, g=vec2(-180.0+360.0*uv.x,90.0-180.0*uv.y);
  float B=360.0/uOut.x, m=min(min(g.x-uNearBox.x,uNearBox.y-g.x),min(g.y-uNearBox.z,uNearBox.w-g.y));
  float wN=uHasN.x>0.5?smoothstep(0.0,2.0,m):0.0;
  vec3 c=vec3(0.0);
  if(wN<1.0) c=textureLod(uLights,uv,log2(max(B*float(textureSize(uLights,0).x)/360.0,1.0))).rgb;
  if(wN>0.0){
    vec2 n=vec2((g.x-uNearBox.x)/(uNearBox.y-uNearBox.x),(uNearBox.w-g.y)/(uNearBox.w-uNearBox.z));
    c=mix(c,textureLod(uLightsN,n,log2(max(B*float(textureSize(uLightsN,0).x)/(uNearBox.y-uNearBox.x),1.0))).rgb,wN);
  }
  o=vec4(c,1.0);
  return o;
}
`,
};
const FLIGHT = ["common", "sky", "ignite", "streaks", "earth", "nebula", "moon", "arrival", "shock"], DOOR = ["common", "earth"];

/* the scene's functions, in two weights (a ladder: the door draws the lean one first, and the rich one only if this
   machine has room for it). LEAN (slab false): the clouds a flat cover on the ground, lit as the ground is, as the
   Earth was before the slab; the cheapest Earth, and what the flight draws unless the door has gone rich. RICH (slab
   true): dawn.py's cloud slab, marched through the low air from the fields made once a context (cloudField, cityGlow).
   door: the Earth alone (DOOR, above), for the live door */
/* (RICH: its two passes with it, PARTS.passes, which its main draws in place of the scene when asked: PASS_SWITCH) */
export function sceneHead({ slab = false, door = false } = {}) {
  const want = [...(door ? DOOR : FLIGHT), ...(slab ? ["passes"] : [])];
  return `#version 300 es
${slab ? "#define SLAB 1\n#define HAS_PASSES 1\n" : ""}precision highp float;
${UNIFORMS.filter(([part]) => !door || want.includes(part)).map(([, u]) => u).join("\n")}
${want.map((part) => PARTS[part]).join("")}`;
}

/* the rush, beneath: the sky, the galaxy, the streaks, the nebula (its Earth is OVER's) */
const SCENE = sceneHead() + `void main(){
  vec2 css=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uPx;
  float ring; vec2 bent=shockBend(css,ring);
  vec3 c=sky(bent);
  if(uG3>0.001){
    /* the galaxy over the dawn's own sky, not in place of it, so the stars carry straight through; only as the flight
       comes to rest inside does that sky give way to the galaxy's own far stars, turning with the camera */
    vec4 g4=texture(uGalTex,gl_FragCoord.xy/uRes);
    float mid=exp(-pow((css.x/(uRes.x/uPx)-0.5)/0.2,2.0));
    vec3 back=c;
    if(uGalPage>0.001){
      float f=uRes.y/uPx*0.95;
      vec3 dv=uGCamR*normalize(vec3((css.x-uRes.x/uPx*0.5)/f,(uRes.y/uPx*0.5-css.y)/f,1.0));
      back=mix(c,vec3(0.0011,0.001,0.001)+stars(dv,f*uPx)*0.035,uGalPage);
    }
    c=mix(c,back*(1.0-g4.a*0.85)+g4.rgb*(1.0-0.55*mid*uGalPage),uG3);
  }
  /* the way ahead: a faint light on the vanishing point, more of it the faster */
  float rv=length(css-uVP), dg=length(uRes/uPx);
  float sp=abs(uSpeed);
  c+=vec3(0.2,0.19,0.17)*sp*0.08*exp(-rv/(dg*0.45));
  float dust; vec3 neb=nebula(css,dust);
  /* the lanes of the rush carry on into the galaxy (they are its speed), fading only as the flight comes to rest in it */
  float lanes=1.0-0.9*uGalPage;
  if(lanes>0.01) c=c*(1.0-dust)+streaks(css)*mix(0.45,1.0,uDens)*(1.0-dust*0.6)*lanes+neb;
  /* the doppler: cool ahead, warm at the edges, only at the fastest */
  float dp=pow(max(sp-0.55,0.0)/0.45,2.0);
  c*=mix(vec3(1.0),mix(vec3(0.95,0.98,1.08),vec3(1.12,0.97,0.88),smoothstep(0.2,0.9,rv/dg)),dp*0.5);
  o=vec4(c,1.0);
}`;

/* the scene's own functions, LEAN, whole: the flight's OVER is made of them (door3d.js asks sceneHead for its Earth alone) */
export const SCENE_HEAD = sceneHead();
/* the live door's Earth (door3d.js), once it is drawn: the flight takes up its turn, its clouds, its sun and its air,
   so it starts from the very frame the door shows, and comes back to it */
let door = null;
export const followDoor = (st) => { door = st; };
export const doorIsLive = () => !!door;
/* the flight's RICH Earth, asked for by the door once it has kept its own rich one (door3d.js), so the click's
   handoff does not change the clouds: made in the flight's context as the door's chores, and drawn only once it is
   made (until then, and where it cannot be, the lean one). Resolves when it is ready. (Where the door is rich from the
   first, capability.js, the flight's is too: made with the rest, in place of the lean one, and this resolves at once) */
let richMake = null, richAsk = null, richOK = false, richCompile = null;
const richWaiting = [];
export function wantRich() {
  if (!richAsk) richAsk = new Promise((resolve) => { const go = () => resolve(richMake()); if (richMake) go(); else richWaiting.push(go); });
  return richAsk;
}
/* where the browser compiles on the page's own thread (chores.js: COMPILES_ASIDE false), the rich program is compiled
   with the rest, first of all (chores: "compile"), whether or not it is ever drawn, so its freeze is never under a
   live loop: asked for by the door's own rich compile (door3d.js), and drawn only once the door has gone rich
   (wantRich). Without a flight's world (not made, or not yet), nothing */
export function compileRich() { return richCompile ? richCompile() : Promise.resolve(false); }
export const richReady = () => richOK;

/* what lies over the rush: the Earth, the moon, the star, the docs' constellations, the shock's light. A program of
   its own, drawn over the first and blended by how much of it still shows through (alpha), so the sum is exactly the
   one program it was: two halves compile in well under the time the whole did (Firefox, measured: 0.8 s and 1.05 s,
   against 2.9 s), the page's freeze the shorter by a second */
/* a RICH program's first lines (the flight's OVER, the door's main: door3d.js): one of its passes drawn in place of the
   scene, when asked (uPass: cloudField, cityGlow); a LEAN program has none, and these lines are not there */
export const PASS_SWITCH = `#ifdef HAS_PASSES
  if(uPass==1){ o=fieldPass(); return; } if(uPass==2){ o=glowPass(); return; }
#endif
`;
const OVER_MAIN = `void main(){
${PASS_SWITCH}  vec2 css=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uPx;
  float ring; shockBend(css,ring);
  /* each layer over: what was beneath times (1-a), plus its own light. Kept as how much shows through (T) and what
     is added (S), so the blend gives beneath*T+S */
  float T=1.0; vec3 S=vec3(0.0);
  if(uEarthA>0.0){
    float cov; vec3 e=earthAA(css,cov); float a=cov*uEarthA;
    T*=1.0-a; S=S*(1.0-a)+e*uEarthA;
  }
  vec4 mo=moon(css); T*=1.0-mo.a; S=S*(1.0-mo.a)+mo.rgb;
  S+=arrival(css);
  if(uCN>0) S+=ignite(css);
  /* the shock's own light: a bright edge, red outside and blue in */
  if(ring>0.001){
    vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx, rs=uBloom*H*1.25, w=H*0.006;
    vec3 band=vec3(exp(-pow((r-rs-w*0.5)/w,2.0)),exp(-pow((r-rs)/w,2.0)),exp(-pow((r-rs+w*0.5)/w,2.0)));
    S+=mix(vec3(dot(band,vec3(0.34))),band,0.35)*vec3(1.0,0.86,0.66)*0.32*(1.0-uBloom)*(1.0-uBloom);
  }
  o=vec4(S,1.0-T);
}`;
/* drawn LEAN, made with the rest (a shorter compile, Firefox's the longest); RICH made only when the door has gone
   rich (wantRich), and drawn only once it is made; or, where the door is rich from the first, RICH in place of the lean */
const OVER = SCENE_HEAD + OVER_MAIN, OVER_RICH = sceneHead({ slab: true }) + OVER_MAIN;

/* after the scene, one program in three ways (uMode): 0, a step down the bloom's chain (13 taps; the first keeps only
   the bright); 1, a step back up it (a tent); 2, the film: bloom laid in, the door's own tone curve (so the Earth here
   is the Earth there), grain */
const POST = `#version 300 es
precision highp float;
uniform int uMode;
uniform sampler2D uSrc, uHdr, uBloom; uniform vec2 uTexel, uOut, uRes; uniform float uFirst, uTime, uExpo; out vec4 o;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
vec3 s(vec2 uv){ vec3 c=texture(uSrc,uv).rgb; if(uFirst>0.5){ float l=max(c.r,max(c.g,c.b)); c*=max(l-0.9,0.0)/max(l,1e-4); } return c; }
vec4 down(){ vec2 uv=gl_FragCoord.xy/uOut, t=uTexel;
  vec3 a=s(uv+t*vec2(-2,2)),b=s(uv+t*vec2(0,2)),c=s(uv+t*vec2(2,2)),d=s(uv+t*vec2(-2,0)),e=s(uv),f=s(uv+t*vec2(2,0)),g=s(uv+t*vec2(-2,-2)),h=s(uv+t*vec2(0,-2)),i=s(uv+t*vec2(2,-2)),j=s(uv+t*vec2(-1,1)),k=s(uv+t*vec2(1,1)),l=s(uv+t*vec2(-1,-1)),m=s(uv+t*vec2(1,-1));
  return vec4(e*0.125+(a+c+g+i)*0.03125+(b+d+f+h)*0.0625+(j+k+l+m)*0.125,1.0); }
vec4 up(){ vec2 uv=gl_FragCoord.xy/uOut, t=uTexel;
  vec3 r=texture(uSrc,uv).rgb*4.0;
  r+=(texture(uSrc,uv+vec2(-t.x,0)).rgb+texture(uSrc,uv+vec2(t.x,0)).rgb+texture(uSrc,uv+vec2(0,-t.y)).rgb+texture(uSrc,uv+vec2(0,t.y)).rgb)*2.0;
  r+=texture(uSrc,uv-t).rgb+texture(uSrc,uv+t).rgb+texture(uSrc,uv+vec2(t.x,-t.y)).rgb+texture(uSrc,uv+vec2(-t.x,t.y)).rgb;
  return vec4(r/16.0,1.0); }
vec4 film(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 r=uv-0.5; float f=0.004*dot(r,r);
  vec3 c=vec3(texture(uHdr,uv+r*f).r,texture(uHdr,uv).g,texture(uHdr,uv-r*f).b);
  c+=texture(uBloom,uv).rgb*0.22;
  c=1.0-exp(-max(c,0.0)*uExpo);
  float l=dot(c,vec3(0.2126,0.7152,0.0722)); c=max(mix(vec3(l),c,1.08),0.0);
  c=pow(c,vec3(1.0/2.2));
  float gr=hash13(vec3(gl_FragCoord.xy,floor(uTime*24.0)))+hash13(vec3(gl_FragCoord.yx*1.7,floor(uTime*24.0)+3.0))-1.0;
  c+=gr*0.03*(0.2+3.0*l*(1.0-l))+(hash13(vec3(gl_FragCoord.xy,uTime*60.0))-0.5)/255.0;
  return vec4(c,1.0);
}
void main(){ if(uMode==0) o=down(); else if(uMode==1) o=up(); else o=film(); }`;

/* ── THE GALAXY, for the docs' flight: a spiral of stars, gas and dust in three dimensions, seen by a camera that
   flies at it from outside, dives into an arm and comes to rest inside the disc looking at the core, where it is the
   Milky Way's band across the sky. Galaxy space: the disc in x–z, y up, its radius about 1. Drawn at half the
   frame's size by marching each ray through the disc's slab: light given off by the stars (gold in the bulge,
   blue-white along the arms, pink where hydrogen glows) and taken away by the dust (in lanes on the arms' inner
   edges, in filaments) — front to back, jittered so the steps never band. The stars themselves are points
   (STARV below), so they pass with their true parallax. ── */
const GAL = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform vec3 uCamP; uniform mat3 uCamR; uniform float uF, uTime, uGain;
out vec4 o;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float vnoise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y),f.z);
}
/* two arms, a logarithmic spiral about 18 degrees open, with a phase to shift along them */
float arm(vec3 p,float off,float k){
  float r=length(p.xz), th=atan(p.z,p.x), ph=th-log(max(r,0.03))*3.1+off;
  return pow(0.5+0.5*cos(2.0*ph),k);
}
vec4 field(vec3 p){
  float r=length(p.xz), y=p.y;
  float n=vnoise(p*6.0), n2=vnoise(p*vec3(24.0,48.0,24.0)+3.0), n3=vnoise(p*vec3(64.0,90.0,64.0)+9.0);
  /* the arms, their line worried by the noise, so they break into spurs and feathers */
  vec3 q=p+vec3(n-0.5,0.0,n2-0.5)*0.07;
  float a=arm(q,0.0,4.0), a4=arm(q*1.0,1.2,6.0)*0.35;
  float vert=exp(-abs(y)/0.028);
  float disc=exp(-r/0.36)*vert*smoothstep(1.3,0.8,r);
  float bul=exp(-(r*r+y*y*3.2)/0.012);
  /* the light: a faint old disc, the arms bright with young stars in clumps, the bulge gold */
  float clump=0.35+1.5*n2*n3+0.4*n3*n3;
  float young=disc*(a+a4)*clump;
  vec3 em=vec3(1.0,0.84,0.64)*disc*(0.16+0.18*n)+vec3(0.72,0.84,1.0)*young*2.4+vec3(1.0,0.78,0.5)*bul*5.0;
  /* hydrogen: pink knots strung along the arms */
  em+=vec3(1.0,0.3,0.42)*smoothstep(0.66,0.9,n2*0.55+n3*0.55)*young*5.0;
  /* dust: a thin layer, dark lanes on the arms' inner edges, torn into filaments */
  float ad=arm(q,-0.55,3.0);
  float fil=1.0-abs(2.0*n3-1.0);
  float dust=exp(-r/0.55)*exp(-abs(y)/0.009)*smoothstep(1.2,0.55,r)*(0.1+2.4*ad)*smoothstep(0.3,0.75,n*0.4+n2*0.3+fil*0.3+ad*0.2);
  return vec4(em,dust*65.0);
}
void main(){
  vec2 uv=gl_FragCoord.xy;
  vec3 ro=uCamP, rd=normalize(uCamR*vec3((uv.x-uRes.x*0.5)/uF,(uv.y-uRes.y*0.5)/uF,1.0));
  /* only the slab of the disc is marched: where the ray is in it */
  const float SL=0.16;
  float t0=0.0, t1=60.0;
  if(abs(rd.y)>1e-4){ float ta=(-SL-ro.y)/rd.y, tb=(SL-ro.y)/rd.y; t0=max(0.0,min(ta,tb)); t1=min(t1,max(ta,tb)); }
  else if(abs(ro.y)>SL){ o=vec4(0.0); return; }
  /* and inside the disc's reach */
  float b=dot(ro.xz,rd.xz), aa=dot(rd.xz,rd.xz), c=dot(ro.xz,ro.xz)-1.45*1.45, d=b*b-aa*c;
  if(d<0.0){ o=vec4(0.0); return; }
  d=sqrt(d); t0=max(t0,(-b-d)/aa); t1=min(t1,(-b+d)/aa);
  if(t1<=t0){ o=vec4(0.0); return; }
  float span=t1-t0, jit=hash13(vec3(uv,fract(uTime)*97.0));
  vec3 col=vec3(0.0); float T=1.0, t=t0;
  for(int i=0;i<52;i++){
    float dt=clamp(t*0.085,0.006,span/34.0+0.004);
    float ts=t+dt*jit;
    if(ts>t1||T<0.015) break;
    vec4 f=field(ro+rd*ts);
    /* close by, the disc is its stars (the points), not a glow: the light fades in with distance, so the camera
       inside the disc sees the band, not a fog */
    f.rgb*=smoothstep(0.04,0.45,ts); f.a*=smoothstep(0.005,0.08,ts);
    col+=T*f.rgb*dt; T*=exp(-f.a*dt);
    t+=dt;
  }
  o=vec4(col*uGain,1.0-T);
}`;
/* the galaxy's stars: each a point in galaxy space, drawn as the short streak it makes between the last frame's
   camera and this one (its light shared along it), or as a soft point; brighter as it is nearer */
const STARV = `#version 300 es
layout(location=0) in vec4 aP; layout(location=1) in vec3 aC;
uniform vec3 uCamP, uPrevP; uniform mat3 uCamR, uPrevR; uniform vec2 uRes; uniform float uF, uK, uPts;
out vec3 vC;
void main(){
  bool odd=(gl_VertexID&1)==1;
  vec3 qc=transpose(uCamR)*(aP.xyz-uCamP), qp=transpose(uPrevR)*(aP.xyz-uPrevP);
  if(qc.z<0.003||qp.z<0.003||(odd&&uPts>0.5)){ gl_Position=vec4(2.0,2.0,2.0,1.0); vC=vec3(0.0); gl_PointSize=1.0; return; }
  vec2 sc=qc.xy/qc.z*uF, sp=qp.xy/qp.z*uF;
  vec2 s=odd?sp:sc;
  gl_Position=vec4(s/(uRes*0.5),0.0,1.0);
  float br=aP.w*uK/(qc.z*qc.z+0.0006);
  /* a star deep in the disc and far off is seen through the dust, as the glow is: dimmed with its distance */
  br*=exp(-length(aP.xyz-uCamP)*3.2*exp(-abs(aP.y)/0.02)*smoothstep(1.25,0.6,length(aP.xz)));
  float len=length(sc-sp);
  vC=aC*min(br,24.0)/(1.0+len*0.8);
  gl_PointSize=uPts>0.5?clamp(1.0+sqrt(min(br,24.0))*0.45,1.0,3.6):1.0;
}`;
const STARF = `#version 300 es
precision highp float;
uniform float uPts; in vec3 vC; out vec4 o;
void main(){ vec2 d=gl_PointCoord-0.5; float a=uPts>0.5?exp(-dot(d,d)*14.0):1.0; o=vec4(vC*a,1.0); }`;
/* the rush's program and the galaxy's, as sources, for the tests (tests/t-compile.js) */
export const SOURCES = { scene: SCENE, galaxy: GAL };
/* the galaxy's stars, made once: most in the disc and thickest along the arms, some in the bulge, and a cloud of
   them about the place the flight comes to rest, so there are stars close by to pass */
const REST = [0.56, 0, 0];
function galaxyStars(n) {
  let sd = 4242; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2832 * rnd());
  const P = new Float32Array(n * 2 * 4), C = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    let x, y, z, col, w;
    const kind = rnd();
    if (kind < 0.8) {
      /* the disc, along the arms */
      let r, th, tries = 0;
      do { r = Math.min(1.25, -Math.log(rnd() + 1e-9) * 0.33 + 0.04); th = rnd() * 6.2832; tries++; }
      while (tries < 8 && rnd() > Math.pow(0.5 + 0.5 * Math.cos(2 * (th - Math.log(Math.max(r, 0.03)) * 3.1)), 2) * 0.85 + 0.15);
      x = r * Math.cos(th); z = r * Math.sin(th); y = gauss() * 0.04;
      const yb = rnd(); col = yb < 0.35 ? [0.7, 0.8, 1] : yb < 0.8 ? [1, 0.97, 0.92] : [1, 0.82, 0.62];
      w = 0.25 + Math.pow(rnd(), 6) * 3;
    } else if (kind < 0.93) {
      /* the bulge */
      x = gauss() * 0.09; z = gauss() * 0.09; y = gauss() * 0.055;
      col = rnd() < 0.7 ? [1, 0.85, 0.62] : [1, 0.72, 0.5]; w = 0.3 + Math.pow(rnd(), 5) * 2;
    } else {
      /* the neighbourhood the flight comes to */
      const rr = Math.pow(rnd(), 0.5) * 0.22;
      const u = rnd() * 2 - 1, ph = rnd() * 6.2832, sq = Math.sqrt(1 - u * u);
      x = REST[0] + rr * sq * Math.cos(ph); z = REST[2] + rr * sq * Math.sin(ph); y = REST[1] + rr * u * 0.35;
      const yb = rnd(); col = yb < 0.25 ? [0.72, 0.8, 1] : yb < 0.7 ? [1, 0.97, 0.93] : yb < 0.92 ? [1, 0.86, 0.68] : [1, 0.62, 0.45];
      w = 0.04 + Math.pow(rnd(), 9) * 0.6;
    }
    for (let k = 0; k < 2; k++) { P.set([x, y, z, w], (i * 2 + k) * 4); C.set(col, (i * 2 + k) * 3); }
  }
  return { P, C };
}

/* the door's camera (tools/dawn.py): over the Atlantic, facing the sunrise over Europe */
const RE = 6371, ALT = 800, LAT = 46, LON = -27, HEAD = 72, SUN_UNDER = 0.15;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
export function doorCamera(sunUnder = SUN_UNDER) {
  const r = Math.PI / 180, la = LAT * r, lo = LON * r, hd = HEAD * r;
  const Z = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const E = [-Math.sin(lo), Math.cos(lo), 0], N = cross(Z, E);
  const H = add(mul(N, Math.cos(hd)), mul(E, Math.sin(hd))), R = cross(H, Z);
  const D0 = (RE + ALT) / RE, F = 3000 / Math.tan(Math.asin(1 / D0));
  /* the sun: the horizon point it rises at, turned SUN_UNDER degrees under it */
  const sd = norm(add(add(mul(R, 0), mul(H, 3000)), mul(Z, -F)));
  const ax = norm(cross(sd, mul(Z, -1))), a = sunUnder * r;
  const S = norm(add(add(mul(sd, Math.cos(a)), mul(cross(ax, sd), Math.sin(a))), mul(ax, dot(ax, sd) * (1 - Math.cos(a)))));
  return { B: [...R, ...H, ...mul(Z, -1)], S, D0 };
}

export function createVoyage(under) {
  if (typeof document === "undefined" || !under?.parentNode) return null;
  const canvas = document.createElement("canvas");
  canvas.id = "warpgl"; canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, powerPreference: "high-performance" });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
  gl.getExtension("OES_texture_float_linear");
  under.parentNode.insertBefore(canvas, under);

  /* the shaders are made in the background where the browser can (KHR_parallel_shader_compile): asked for here,
     and only looked at once they are done (made, below), so making them never holds the page up */
  const par = gl.getExtension("KHR_parallel_shader_compile");
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  /* (when the compiles began: how long they took, to the last link status read, is said once they are done) */
  const t0 = performance.now();
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const program = (fsrc, vsh = vs, label = "flight") => {
    const p = gl.createProgram(), fs = shader(gl.FRAGMENT_SHADER, fsrc);
    gl.attachShader(p, vsh); gl.attachShader(p, fs); gl.linkProgram(p); linked(label);
    return { p, fs, vsh, u: {} };
  };
  const finish = (pr) => {
    if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr.p) || gl.getShaderInfoLog(pr.fs) || gl.getShaderInfoLog(pr.vsh));
    const n = gl.getProgramParameter(pr.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(pr.p, i); pr.u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(pr.p, a.name); }
  };
  /* the live door's weight (capability.js; only where the door is live here, ?door3d at level 1 or 2, chosen before the
     flight's world is made: engine.js): "rich", and what lies over the rush is the RICH Earth from the first, in place
     of the lean one (the door draws the rich from its first frame); "lean", the lean alone, the rich never made; "both"
     (and without a live door), the lean, and the rich made only if the door goes rich (wantRich). Without a live door
     (level 0, or no ?door3d) the flight is as it always was: no strip, no sharp tier, the lean overlay */
  const live = liveDoor();
  const weight = live ? theDoorWeight() : null, richOnly = weight === "rich";
  const P = { scene: program(SCENE), over: program(richOnly ? OVER_RICH : OVER), post: program(POST), gal: null, stars: null };
  const compiled = (list) => new Promise((resolve) => {
    if (!par) { resolve(); return; }
    const poll = () => (list.every((pr) => gl.getProgramParameter(pr.p, par.COMPLETION_STATUS_KHR)) ? resolve() : setTimeout(poll, 40));
    poll();
  });
  let ok = false, dead = false;
  const core = Object.values(P).filter(Boolean);
  const made = compiled(core).then(() => {
    try { core.forEach(finish); ok = true; } catch (e) { console.warn(e); dead = true; canvas.remove(); }
    if (ok && richOnly) P.overRich = P.over;
    if (ok) note(`flight: shaders compiled in ${Math.round(performance.now() - t0)} ms${counted("flight")}`);
    return ok;
  });
  /* the docs' galaxy and its stars are wanted by the docs' flight alone, so the flight is not kept waiting for them:
     where the browser compiles in the background they are a chore of their own ("galaxy", ranked after the live door
     and the measures: chores.js), so they are compiled once the door is live, not beside the rest during the reveal
     (the docs' journey still hurries them: "docs"); where it compiles on the page's own thread (Firefox:
     compilesAside false) they are a "compile" chore, queued now, behind the flight's, so they too are done under the
     first light's ring (main.js waits for them: engine.js, compiled) */
  let galOK = false, galMade = null;
  const makeGal = () => {
    if (!galMade) {
      const g0 = performance.now();
      const G = { gal: program(GAL, vs, "galaxy"), stars: program(STARF, shader(gl.VERTEX_SHADER, STARV), "galaxy") };
      galMade = compiled(Object.values(G)).then(() => {
        try {
          Object.values(G).forEach(finish); Object.assign(P, G); galOK = true;
          note(`docs galaxy: shaders compiled in ${Math.round(performance.now() - g0)} ms${counted("galaxy")}`);
        } catch (e) { console.warn("orbit: the docs' galaxy could not be drawn", e); }
      });
    }
    return galMade;
  };
  /* (in the background the chore only starts them and lets the queue go, so the door's measures, which wait for it
     to be at rest, are not held for a compile that costs the page nothing) */
  const galaxy = compilesAside() ? chore(() => { makeGal(); }, 60, ["galaxy", "docs"]).then(() => galMade).catch(() => {}) : chore(makeGal, 20, ["compile", "docs"]).catch(() => {});
  const vao = gl.createVertexArray();

  /* the rich Earth (wantRich, above): its program (where the door is rich from the first, the overlay itself), the
     slab's fields of the clouds maps and the cities' glow its clouds take from below, both drawn by that program
     (cloudField, cityGlow): a field as soon as its map and the program are both there, the glow once every map has
     come (loaded); drawn only when all are done (richOK) */
  let richMade = null, richProg = null, allIn = false;
  const fieldsOf = () => {
    for (const key of ["clouds", "cloudsN"]) {
      if (!P.overRich || !maps[key] || !mipped.has(key) || fields[key]) continue;
      try { fields[key] = cloudField(gl, P.overRich, maps[key], ...dims[key], key === "cloudsN"); } catch (e) { console.warn("orbit: no cloud field", e); }
    }
  };
  const richMaps = () => {
    fieldsOf();
    if (P.overRich && allIn && !glowT && maps.lights) glowT = cityGlow(gl, P.overRich, maps.lights, ...dims.lights, maps.lightsN, blank);
    return (richOK = !!(P.overRich && glowT));
  };
  /* its program alone, where it is made apart (the door's weight "both"; tag: the chores', "door" when asked for by
     wantRich, "compile" by compileRich), made once; the fields of the maps already there made with it */
  const richProgram = (tag) => richProg || (richProg = made.then((good) => good && chore(() => {
    const r0 = performance.now(), pr = program(OVER_RICH);
    return compiled([pr]).then(() => ({ pr, r0 }));
  }, tag === "compile" ? 20 : 60, tag)
    .then(({ pr, r0 }) => chore(() => {
      finish(pr); P.overRich = pr; fieldsOf();
      note(`flight: rich Earth compiled in ${Math.round(performance.now() - r0)} ms${counted("flight")}`);
      return true;
    }, tag === "compile" ? 20 : 60, tag))));
  /* rich from the first: made with the rest (made), its fields and glow with the maps (warm); lean: never made */
  richCompile = richOnly ? () => made
    : weight === "lean" ? () => Promise.resolve(false)
    : () => richProgram("compile").catch((e) => { console.warn("orbit: the flight's rich Earth could not be made", e); return false; });
  richMake = () => richMade || (richMade = made.then((good) => {
    if (!good || weight === "lean") return false;
    warm();
    if (richOnly) return warming.then(() => richOK);
    return richProgram("door").then((p) => p && loaded.then(() => chore(richMaps, 60, "door")));
  }).catch((e) => { console.warn("orbit: the flight's rich Earth could not be made", e); return false; }));
  richWaiting.splice(0).forEach((go) => go());

  const tex = (w, h, fmt, f, type, data = null) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, f, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const target = (w, h) => { const t = tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT); const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { t, f, w, h }; };

  /* the maps: asked for a little after the page is up, each used as soon as it has come; mipped: those whose mipmaps
     are made too (a field is made from a map only then) */
  const maps = {}, dims = {}, fields = {}, mipped = new Set();
  let glowT = null;
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  /* each picture is fetched and decoded as soon as it is asked for (off the page's thread), and put on the GPU a band
     at a time (upload.js: soft chores, which may run during the reveal), its mipmaps after, a chore of their own */
  const wrapOf = (key) => (g) => {
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, BOXED.includes(key) ? g.CLAMP_TO_EDGE : g.REPEAT);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  };
  /* the ground is seen almost edge on at first: without this the cities blur into the coarsest maps */
  const sharper = (g) => { if (aniso) g.texParameterf(g.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, g.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT))); };
  /* the sharper strip, put on the GPU whole (sharpStrip: in every context in the one chore, its fade started on the
     same clock; the last chore of all, never during the reveal) */
  const upload = (key, bm) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    sharper(gl); wrapOf(key)(gl);
    return t;
  };
  /* the strip's sharper tier, fading in over the small one (sharpStrip; ?door3d only) */
  let stripS = null;
  /* drawn from its last band (its first level alone, LINEAR); loaded, and so the fields, the glow and the warm draws,
     only once its mipmaps are made */
  const load = (key) => fetchOnce(pictures()[key])
    .then((b) => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bm) => {
      const wh = [bm.width, bm.height];
      return uploadBanded(gl, bm, { tag: "flight", name: key, setup: wrapOf(key), after: sharper, drawable: (t) => { maps[key] = t; dims[key] = wh; } });
    })
    .then(() => {
      mipped.add(key);
      /* a clouds map's slab field, made with it if the rich Earth is already there (else with the rich Earth: richProgram) */
      if (key === "clouds" || key === "cloudsN") fieldsOf();
    }).catch(() => { /* drawn without it */ });
  /* the maps, the warm-up and the measure, asked for once (main.js asks while the door is quiet); `ready` says when */
  let warming = null, warmingDocs = null, loaded = null;
  const warmDocs = () => { warm(); return warmingDocs; };
  function warm() {
    if (!warming) {
      const ST = () => ({ t: 1900, v: 1, K: 7.4, vp: [W / 2, -0.55 * H], rmax: Math.hypot(W, H) * 1.55, tint: [1, 0.8, 0.4],
        progress: 0.4, world: null, bloom: 0, tu: 1900, star: true, dt: 0 });
      /* the strip only where the door is live (the same one the door draws: theStrip): the small one waited for, the
         device's own after everything (sharpStrip) */
      if (live) stripS = sharpStrip();
      const loadStrip = () => load("lightsS").then(() => {
        if (maps.lightsS) stripS.ready((bm) => { maps.lightsS2 = upload("lightsS", bm); }); else stripS.fail();
      });
      loaded = Promise.all([...["lights", "euro", "clouds", "day", "moon", "lightsN", "cloudsN", "dayN"].map(load), ...(live ? [loadStrip()] : [])])
        .then(() => { allIn = true; });
      warming = Promise.all([made, loaded])
        /* rich from the first: its fields and its glow, before anything is drawn with it */
        .then(() => richOnly && chore(richMaps, 60, "flight"))
        .then(() => chore(() => { try { makeStars(); } catch { /* drawn without them */ } }, 60, "flight"))
        /* each way the flight draws, drawn once into a corner of a few pixels, so the GPU has everything made for it
           (drivers finish their shaders on the first draw) before a flight, at no cost to see */
        .then(() => chore(() => touch(ST()), 60, "flight"))
        .then(() => chore(() => touch({ ...ST(), world: { cx: W / 2, cy: H * 3, R: H * 2.4, alpha: 1, c: 0.1 }, tu: 900 }), 60, "flight"));
      /* the docs' galaxy after it, the docs' own (warmDocs): the flight is ready before it */
      warmingDocs = warming
        .then(() => galaxy)
        .then(() => chore(() => { if (galOK) touch({ ...ST(), tu: 3000, galaxy3d: galaxyAt([0.8, 0.08, 0.38]), cstars: [[W / 2, H / 2, 2, 1, 1, 1, 1]] }); }, 60, "docs"));
      /* the measure is never hurried, and nothing waits on it: a flight that comes first is drawn as it is */
      warming.then(() => chore(calibrate, 200, "measure"));
    }
    return warming;
  }
  /* a camera in the docs' galaxy, looking at its core */
  function galaxyAt(P) {
    const l = Math.hypot(...P), f = P.map((x) => -x / l);
    const c = [f[2], 0, -f[0]], lc = Math.hypot(...c), r = c.map((x) => x / lc);
    const up = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    return { w: 1, P, R: [...r, ...up, ...f], gain: 5.5, starK: 0.09, page: 0 };
  }
  function touch(st) {
    if (!ok) return;
    if (W < 2) resize(innerWidth, innerHeight);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 4, 4);
    try { draw(st); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } catch { /* fine */ }
    gl.disable(gl.SCISSOR_TEST); lastDraw = 0;
  }
  /* then the measure: a few whole frames at the heaviest point of the flight (the nebula, the streaks at full speed),
     timed, and the drawing's size chosen so a frame takes about 11 ms here; the galaxy's own drawing in proportion */
  function calibrate() {
    if (!ok || document.hidden || (lastDraw && performance.now() - lastDraw < 5000)) return;
    if (W < 2) resize(innerWidth, innerHeight);
    const st = { t: 1900, v: 1, K: 7.4, vp: [W / 2, -0.55 * H], rmax: Math.hypot(W, H) * 1.55, tint: [1, 0.8, 0.4],
      progress: 0.4, world: null, bloom: 0, tu: 1900, star: true, dt: 0 };
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    try {
      draw(st); sync();
      const t0 = performance.now(); for (let i = 0; i < 2; i++) draw(st); sync();
      const ms = (performance.now() - t0) / 2;
      const next = Math.min(0.9, Math.max(0.4, part * Math.sqrt(11 / Math.max(ms, 1))));
      const nq = next >= 0.7 ? 0.45 : next >= 0.55 ? 0.4 : 0.34;
      if (Math.abs(next - part) > 0.02 || nq !== gq) { part = next; gq = nq; CW = 0; resize(W, H); }
    } catch { /* drawn as it is */ }
    lastDraw = 0;
  }
  const blank = tex(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  /* the sun's table, made with the first frame that wants it */
  let sunTex = null;

  const cam = doorCamera();
  /* gq: the galaxy's own drawing size, as a part of the frame's (measured in calibrate, so it costs about 5 ms) */
  let W = 1, H = 1, part = 0.75, hdr = null, chain = [], frames = [], CW = 0, CH = 0, lastDraw = 0, galT = null, gq = 0.45;
  /* the galaxy's stars, put on the GPU once (warm) */
  let starVao = null, starN = 0;
  function makeStars() {
    if (starVao) return;
    const { P: pos, C: col } = galaxyStars(48000);
    starVao = gl.createVertexArray(); gl.bindVertexArray(starVao);
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); starN = pos.length / 4;
  }
  /* the streaks' travel, per depth: log radius, integrated from the flight's own speed */
  const off = [0, 0.3, 0.7, 0.15];

  function resize(w, h) {
    W = w; H = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* the whole frame is moving: drawn at a part of the screen's density, no more than about 1.6 million pixels */
    const px = Math.min(dpr * part, Math.sqrt(1.6e6 / Math.max(1, W * H)));
    const cw = Math.max(1, Math.round(W * px)), ch = Math.max(1, Math.round(H * px));
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    if (cw === CW && ch === CH) return;
    CW = cw; CH = ch; canvas.width = cw; canvas.height = ch;
    for (const c of [hdr, ...chain]) if (c) { gl.deleteTexture(c.t); gl.deleteFramebuffer(c.f); }
    if (galT) { gl.deleteTexture(galT.t); gl.deleteFramebuffer(galT.f); }
    hdr = target(cw, ch); chain = []; galT = target(Math.max(1, Math.round(cw * gq)), Math.max(1, Math.round(ch * gq)));
    /* the bloom's halvings are a fixed share of the screen's height, not of the drawing, so its glow spreads the same
       however finely the frame is drawn and whatever the window: sized from the drawing, a frame drawn coarser (a slow
       measure, or a slow flight before it) glowed up to twice as wide, a haze over the docs' galaxy that came and
       went, and the docs' sky (docsky.cjs, drawn wide) wore another glow than the flight it is the end of */
    let b = 900, a = Math.max(1, Math.round(b * W / Math.max(1, H)));
    for (let i = 0; i < 5; i++) { a = Math.max(1, a >> 1); b = Math.max(1, b >> 1); chain.push(target(a, b)); }
  }
  const pass = (prog, fbo, w, h, setup) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p); gl.bindVertexArray(vao); setup(prog.u); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const bind = (unit, t, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit); };

  /* the flight's speed moves the streaks: each depth outwards at its own rate */
  let nebOff = 0;
  function advance(v, dt, K) { for (let i = 0; i < 4; i++) off[i] += v * dt * K * (0.35 + 0.22 * i) * 0.55; nebOff += v * dt * K * 0.16; }

  /* s: { t (ms), v (signed speed), K, vp [x,y], rmax, tint [r,g,b], progress (0..1 of the climb),
          world: { cx, cy, R, alpha, c } | null, bloom (0..1), bloomPt [x,y], dt (ms) } */
  function draw(s) {
    if (!ok) return;
    if (!hdr) resize(W, H);
    /* the size is never changed mid-flight (a change reallocates every target, and that is a hitch): a slow flight
       is noted, and the next one is drawn smaller, the change made while nothing is flying */
    lastDraw = performance.now();
    if (s.dt) { frames.push(s.dt); if (frames.length === 40) {
      const avg = frames.slice(5).reduce((a, b) => a + b, 0) / 35;
      const next = avg > 26 ? Math.max(0.4, part * 0.82) : avg < 13 ? Math.min(0.9, part * 1.08) : part;
      if (Math.abs(next - part) > 0.02) setTimeout(function later() {
        if (performance.now() - lastDraw < 400) { setTimeout(later, 1000); return; }
        part = next; resize(W, H);
      }, 1000);
    } }
    const px = CW / W;
    const sp = Math.abs(s.v), shutter = 0.016 * (1 + 0.9 * sp * sp);
    const len = [0, 1, 2, 3].map((i) => Math.abs(s.v) * s.K * (0.35 + 0.22 * i) * shutter * 0.55 * 2.0);
    const w = s.world;
    /* the camera's height over the Earth grows as the world shrinks on the screen */
    const D = w ? cam.D0 * Math.pow(1 + 6 * Math.pow(w.c, 1.3), 0.6) : cam.D0;
    /* the sky turns as the climb tilts towards the way ahead */
    const pitch = -0.32 + 0.55 * s.progress, yaw = 2.5 + 0.12 * s.progress, roll = 0.62;
    const cx = Math.cos(pitch), sx = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw), cz = Math.cos(roll), sz = Math.sin(roll);
    /* Ry · Rx · Rz, column-major */
    const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1], Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx], Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
    const mm = (a, b) => { const o = []; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o.push(a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]); return o; };
    const SK = mm(Ry, mm(Rx, Rz));
    gl.disable(gl.BLEND);
    const g3 = galOK && s.galaxy3d && s.galaxy3d.w > 0.001 ? s.galaxy3d : null;
    if (g3) pass(P.gal, galT.f, galT.w, galT.h, (u) => {
      gl.uniform2f(u.uRes, galT.w, galT.h); gl.uniform3fv(u.uCamP, g3.P); gl.uniformMatrix3fv(u.uCamR, false, new Float32Array(g3.R));
      gl.uniform1f(u.uF, galT.h * 0.95); gl.uniform1f(u.uTime, (s.t / 1000) % 1000); gl.uniform1f(u.uGain, g3.gain);
    });
    const sceneU = (u) => {
      gl.uniform2f(u.uRes, CW, CH); gl.uniform1f(u.uPx, px); gl.uniform1f(u.uTime, (s.t / 1000) % 1000);
      gl.uniform2f(u.uVP, s.vp[0], s.vp[1]); gl.uniform1f(u.uSpeed, s.v); gl.uniform1f(u.uRmax, s.rmax);
      gl.uniform4fv(u.uOff, off); gl.uniform4fv(u.uLen, len); gl.uniform3fv(u.uTint, s.tint);
      gl.uniform3f(u.uCirc, w ? w.cx : 0, w ? w.cy : 0, w ? w.R : 1); gl.uniform1f(u.uEarthA, w ? w.alpha : 0); gl.uniform1f(u.uD, D);
      gl.uniformMatrix3fv(u.uB, false, new Float32Array(cam.B)); gl.uniform3fv(u.uSun, door?.sun || cam.S);
      gl.uniformMatrix3fv(u.uSpinM, false, new Float32Array(door?.spinM || ID3)); gl.uniform1f(u.uCloudOff, door?.cloudOff || 0);
      /* the door's air at the door (its glows carry the rest), the flight's own as the world falls away */
      { const k = door ? Math.min(1, Math.max(0, (w ? w.c : 1) / 0.35)) : 1; gl.uniform1f(u.uAirK, door ? door.air + (1 - door.air) * k * k * (3 - 2 * k) : 1); }
      gl.uniform4f(u.uHas, maps.lights ? 1 : 0, maps.euro ? 1 : 0, maps.clouds && maps.day ? 1 : 0, 0);
      gl.uniform4f(u.uEuroBox, ...EURO); gl.uniform4f(u.uNearBox, ...NEAR);
      gl.uniform4f(u.uHasN, maps.lightsN ? 1 : 0, maps.cloudsN ? 1 : 0, maps.dayN ? 1 : 0, 0);
      gl.uniform1f(u.uCloudK, maps.clouds ? 1 : 0);
      gl.uniform4f(u.uStripBox, ...(strip ? strip.box : [0, 0, 0, 0])); gl.uniform1f(u.uHasS, live && maps.lightsS ? 1 : 0);
      /* the sharper strip fading in; once in, the small one let go */
      let mixS = maps.lightsS2 ? stripS.mix() : 0;
      if (mixS >= 1) { gl.deleteTexture(maps.lightsS); maps.lightsS = maps.lightsS2; maps.lightsS2 = null; mixS = 0; }
      gl.uniform1f(u.uStripMix, mixS);
      gl.uniformMatrix3fv(u.uSkyM, false, new Float32Array(SK)); gl.uniform1f(u.uStarA, 1);
      /* how thick the field is: the door's sparse sky at rest, filling in as the flight gathers speed */
      { const q = Math.min(1, Math.max(0, (Math.abs(s.v) - 0.03) / 0.6)); gl.uniform1f(u.uDens, q * q * (3 - 2 * q)); }
      const tu = s.tu ?? s.t, sm = (a, b, x) => { const q = Math.min(1, Math.max(0, (x - a) / (b - a))); return q * q * (3 - 2 * q); };
      /* the nebula, through the cruise */
      gl.uniform1f(u.uNeb, s.galaxy3d ? 0 : sm(1200, 1750, tu) * (1 - sm(2350, 2950, tu))); gl.uniform1f(u.uNebOff, nebOff);
      /* the moon, through the acceleration: from near the way ahead, out past the lower right, growing */
      const mAt = (m) => { const tx = W * 0.8, ty = H * 0.68, dx = tx - s.vp[0], dy = ty - s.vp[1], dl = Math.hypot(dx, dy) || 1;
        const r0 = Math.min(dl * 0.35, H * 0.3), r1 = dl + H * 0.75, e = Math.pow(m, 2.3);
        return [s.vp[0] + (dx / dl) * (r0 + (r1 - r0) * e), s.vp[1] + (dy / dl) * (r0 + (r1 - r0) * e), H * (0.003 + 0.6 * Math.pow(m, 3.2))]; };
      const mt = (tu - 700) / 800;
      if (maps.moon && mt > 0 && mt < 1 && s.moon !== false && !s.galaxy3d) {
        const a = mAt(mt), b = mAt(Math.max(0, mt - (1 / 60) / 0.8));
        /* it comes out of the distance: tiny, and faint until it is a third of the way */
        gl.uniform4f(u.uMoonS, a[0], a[1], a[2], sm(0, 0.35, mt)); gl.uniform2f(u.uMoonV, (a[0] - b[0]) * 0.5, (a[1] - b[1]) * 0.5);
      } else gl.uniform4f(u.uMoonS, 0, 0, 1, 0);
      gl.uniform1f(u.uMoonSpin, 0.6 + tu * 0.00025);
      bind(5, maps.moon || blank, u.uMoonT);
      gl.uniform1f(u.uPre, s.bloom != null && s.star !== false ? sm(2500, 3300, tu) : 0);
      gl.uniform1f(u.uBloom, s.bloom || 0); gl.uniform2f(u.uBloomPt, s.bloomPt?.[0] ?? W / 2, s.bloomPt?.[1] ?? H / 2);
      bind(0, maps.lights || blank, u.uLights); bind(1, maps.day || blank, u.uDay); bind(2, maps.clouds || blank, u.uClouds);
      bind(3, maps.euro || blank, u.uEuro);
      bind(10, sunTex || (sunTex = sunTexture(gl)), u.uSunT);
      bind(7, maps.lightsN || blank, u.uLightsN); bind(8, maps.cloudsN || blank, u.uCloudsN); bind(9, maps.dayN || blank, u.uDayN);
      bind(11, (live && maps.lightsS) || blank, u.uLightsS); bind(15, maps.lightsS2 || blank, u.uLightsS2);
      bind(12, fields.clouds || blank, u.uCloudF); bind(13, fields.cloudsN || blank, u.uCloudFN); bind(14, glowT || blank, u.uGlow);
      /* the docs' flight: the Milky Way, and the constellations lighting */
      const cs = s.cstars || [], n = Math.min(64, cs.length);
      if (n) {
        const a = new Float32Array(64 * 4), c = new Float32Array(64 * 3);
        for (let i = 0; i < n; i++) { const t = cs[i]; a.set([t[0], t[1], t[2], t[3]], i * 4); c.set([t[4], t[5], t[6]], i * 3); }
        gl.uniform4fv(u.uCS, a); gl.uniform3fv(u.uCC, c);
      }
      gl.uniform1i(u.uCN, n);
      gl.uniform1f(u.uG3, g3 ? g3.w : 0); bind(6, g3 ? galT.t : blank, u.uGalTex);
      gl.uniform1f(u.uGalPage, g3 ? g3.page || 0 : 0);
      gl.uniformMatrix3fv(u.uGCamR, false, new Float32Array(g3 ? g3.R : [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    };
    pass(P.scene, hdr.f, CW, CH, sceneU);
    /* and what lies over it (OVER, above), blended by how much of the first still shows through */
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    pass(door?.rich && richOK ? P.overRich : P.over, hdr.f, CW, CH, sceneU);
    gl.disable(gl.BLEND);
    /* the galaxy's stars, added into the same light before the bloom: streaks, then their points */
    if (g3 && starVao) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.f); gl.viewport(0, 0, CW, CH);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(P.stars.p); gl.bindVertexArray(starVao);
      const u = P.stars.u;
      gl.uniform3fv(u.uCamP, g3.P); gl.uniform3fv(u.uPrevP, g3.prevP || g3.P);
      gl.uniformMatrix3fv(u.uCamR, false, new Float32Array(g3.R)); gl.uniformMatrix3fv(u.uPrevR, false, new Float32Array(g3.prevR || g3.R));
      gl.uniform2f(u.uRes, CW, CH); gl.uniform1f(u.uF, CH * 0.95); gl.uniform1f(u.uK, (g3.starK ?? 0.0006) * g3.w);
      gl.uniform1f(u.uPts, 0); gl.drawArrays(gl.LINES, 0, starN);
      gl.uniform1f(u.uPts, 1); gl.drawArrays(gl.POINTS, 0, starN);
      gl.bindVertexArray(null); gl.disable(gl.BLEND);
    }
    /* the bloom's steps and the film, one program (POST: uMode); a step's other maps read the one it reads, so none of
       them is ever the target it draws into */
    const step = (u, mode, from) => { gl.uniform1i(u.uMode, mode); bind(0, from.t, u.uSrc); gl.uniform1i(u.uHdr, 0); gl.uniform1i(u.uBloom, 0); };
    let src = hdr;
    chain.forEach((c, i) => { pass(P.post, c.f, c.w, c.h, (u) => { step(u, 0, src); gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h); gl.uniform2f(u.uOut, c.w, c.h); gl.uniform1f(u.uFirst, i === 0 ? 1 : 0); }); src = c; });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = chain.length - 1; i > 0; i--) { const from = chain[i], to = chain[i - 1];
      pass(P.post, to.f, to.w, to.h, (u) => { step(u, 1, from); gl.uniform2f(u.uTexel, 1 / from.w, 1 / from.h); gl.uniform2f(u.uOut, to.w, to.h); }); }
    gl.disable(gl.BLEND);
    pass(P.post, null, CW, CH, (u) => { gl.uniform1i(u.uMode, 2); bind(0, hdr.t, u.uHdr); bind(1, chain[0].t, u.uBloom); gl.uniform1i(u.uSrc, 0); gl.uniform2f(u.uRes, CW, CH);
      gl.uniform1f(u.uTime, (s.t / 1000) % 1000); gl.uniform1f(u.uExpo, 0.35); });
  }
  function clear() { if (!ok) return; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0.012, 0.012, 0.014, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  return { canvas, resize, draw, advance, clear, warm, warmDocs, made, galaxy, get dead() { return dead; }, reset() { off.splice(0, 4, 0, 0.3, 0.7, 0.15); nebOff = 0; frames = []; } };
}
