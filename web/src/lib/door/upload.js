/*
 * A picture put on the GPU a band at a time, so the work fits beside the door's reveal.
 *
 * Put on the GPU whole, a big map stops the page's thread for 40-90 ms, and its mipmaps for 30-170 ms more: too long
 * for any frame, so until now nothing was put on the GPU during the reveal (chores.js: open). Here the texture is made
 * at its full size at once (empty, which is cheap), and the picture goes in a band of rows at a time, each band a soft
 * chore (chores.js: one a frame, from the moment the door is lit), each band's own small bitmap cut from the picture
 * off the page's thread while the one before waits its turn (never more than two at a time). The mipmaps come after
 * the last band, as an ordinary chore (after the reveal): until then the texture is drawable, its first level alone
 * (LINEAR). With ?holdreveal, or where the browser ignores a cut picture's crop (cropHonoured, below), the picture
 * is put on the GPU whole in one chore, its mipmaps with it, as before.
 */
import { chore, note, holdReveal } from "./chores.js";
import { flag } from "./settings.js";

/* a band to start from: about a megabyte (4096 wide: 64 rows; 2048: 128; 1024: 256), never under 16 rows; every band
   timed, and the rows halved after any that took over 4 ms (never doubled: a band doubled after a quick first one
   took 30-50 ms on the laptop in Edge, and the reveal dropped frames) */
const BYTES = 1 << 20, FEWEST = 16, SLOW = 4;
const CUT = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
/* each texture's bands said in the console only with ?door3d (the console stays short otherwise) */
const say = () => !!flag("door3d");

/* whether this browser's WebGL honours a cut bitmap's crop when it is put on the GPU: a picture two rows high, its second
   row cut out and put on the GPU, and what the GPU holds read. Firefox (2026-10) puts the source's top rows in instead, so
   every band of a picture came out as its first rows: the install's planet drew as smooth violet stripes, the top of its
   map over and over (#4); a 2D canvas there honours the crop. Where it is not honoured the picture goes whole, as
   ?holdreveal sends it; asked once per context, and a probe that fails counts as not honoured.
   The GPU's texel is read by a vertex shader into a transform-feedback buffer, never by readPixels (a pixel read back is
   the test frames' sync: ADR-0002), and the buffer is read only once a fence says the GPU has finished with it, so the
   page never waits on the GPU for it. `run(fn)` is how the part that touches the GPU is run (the host's chore, so it takes
   its turn: uploadBanded); the bitmaps for it are made first, off the page's thread, and the wait for the fence is between
   chores */
const probes = new WeakMap();
const TF_VERT = `#version 300 es
uniform sampler2D t; out vec2 v;
void main(){ v = texelFetch(t, ivec2(0, 0), 0).rg; gl_Position = vec4(0.0); }`;
const TF_FRAG = `#version 300 es
precision mediump float; out vec4 o;
void main(){ o = vec4(0.0); }`;
/* the state a probe touches, taken and put back */
function keepState(gl) {
  const was = { unit: gl.getParameter(gl.ACTIVE_TEXTURE), program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    discard: gl.isEnabled(gl.RASTERIZER_DISCARD) };
  gl.activeTexture(gl.TEXTURE0);
  const tex = gl.getParameter(gl.TEXTURE_BINDING_2D), tf = gl.getParameter(gl.TRANSFORM_FEEDBACK_BUFFER_BINDING), read = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
  return () => {
    if (!was.discard) gl.disable(gl.RASTERIZER_DISCARD);
    gl.useProgram(was.program); gl.bindVertexArray(was.vao);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, tf); gl.bindBuffer(gl.COPY_READ_BUFFER, read);
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.activeTexture(was.unit);
  };
}
/* the bitmap put on the GPU and its first texel sent to a buffer: what was made, with a fence behind it */
function submitTexel(gl, bitmap) {
  const T = gl.TEXTURE_2D, B = gl.TRANSFORM_FEEDBACK_BUFFER;
  const restore = keepState(gl);
  const made = { t: gl.createTexture(), buf: gl.createBuffer(), p: gl.createProgram(), shaders: [], sync: null };
  try {
    for (const [type, src] of [[gl.VERTEX_SHADER, TF_VERT], [gl.FRAGMENT_SHADER, TF_FRAG]]) {
      const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); gl.attachShader(made.p, x); made.shaders.push(x);
    }
    gl.transformFeedbackVaryings(made.p, ["v"], gl.SEPARATE_ATTRIBS);
    gl.linkProgram(made.p);
    if (!gl.getProgramParameter(made.p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made.p) || "crop probe: no program");
    gl.bindTexture(T, made.t); gl.texImage2D(T, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindBuffer(B, made.buf); gl.bufferData(B, 8, gl.DYNAMIC_READ); gl.bindBufferBase(B, 0, made.buf);
    gl.bindVertexArray(null); gl.useProgram(made.p); gl.uniform1i(gl.getUniformLocation(made.p, "t"), 0);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, 1); gl.endTransformFeedback();
    gl.bindBufferBase(B, 0, null);
    made.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return made;
  } catch (e) { letGo(gl, made); throw e; }
  finally { restore(); }
}
function letGo(gl, made) {
  if (made.sync) gl.deleteSync(made.sync);
  gl.deleteTexture(made.t); gl.deleteBuffer(made.buf); for (const x of made.shaders) gl.deleteShader(x); gl.deleteProgram(made.p);
}
/* red and green of the texel, once the fence has passed (never waited for longer than the cap) */
async function readTexel(gl, made) {
  try {
    for (const t0 = performance.now(); ;) {
      const s = gl.clientWaitSync(made.sync, 0, 0);
      if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED) break;
      if (s === gl.WAIT_FAILED || performance.now() - t0 > 3000) throw new Error("crop probe: the GPU did not finish");
      await new Promise((r) => setTimeout(r, 4));
    }
    const restore = keepState(gl), out = new Float32Array(2);
    try { gl.bindBuffer(gl.COPY_READ_BUFFER, made.buf); gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out); } finally { restore(); }
    return out;
  } finally { letGo(gl, made); }
}
export function cropHonoured(gl, run = (fn) => fn()) {
  let p = probes.get(gl);
  if (!p) probes.set(gl, (p = (async () => {
    const two = await createImageBitmap(new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 1, 2), CUT);
    const row = await createImageBitmap(two, 0, 1, 1, 1, CUT); two.close?.();
    let rg;
    try { rg = await readTexel(gl, await run(() => submitTexel(gl, row))); } finally { row.close?.(); }
    const ok = rg[0] < 0.5 && rg[1] > 0.5;
    if (say() || !ok) note(`upload: a cut picture's crop ${ok ? "honoured" : "ignored on upload: pictures go whole"}`);
    return ok;
  })().catch(() => false)));
  return p;
}

/** a bitmap put on the GPU in bands (soft chores, tagged tag), its mipmaps after (an ordinary chore) if mips. setup(gl,
    texture): the caller's own parameters (wrap modes), set when the texture is made; after(gl, texture): set with the
    mipmaps (anisotropy); drawable(texture): called once the last band is in (the first level whole, no mipmaps yet);
    keep: the bitmap is not closed at the end (another context still wants it); name: for the console. Resolves with
    the texture once its mipmaps are made (without mips: once the last band is in) */
export function uploadBanded(gl, bitmap, { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, tag = "", mips = true, setup, after, drawable, keep = false, name = "map" } = {}) {
  const T = gl.TEXTURE_2D, w = bitmap.width, h = bitmap.height;
  const params = (t) => {
    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    setup?.(gl, t);
  };
  const levels = (t) => {
    gl.bindTexture(T, t); gl.generateMipmap(T);
    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    after?.(gl, t);
  };
  /* whole, in one ordinary chore, its mipmaps with it: with ?holdreveal, or where a cut picture's crop is not honoured */
  const whole = () => chore(() => {
    const t = gl.createTexture(); gl.bindTexture(T, t);
    gl.texImage2D(T, 0, internal, format, type, bitmap);
    params(t);
    if (mips) levels(t);
    if (!keep) bitmap.close?.();
    drawable?.(t);
    return t;
  }, 60, tag);
  if (holdReveal()) return whole();
  /* (the probe's GPU part is a chore of its own, once a context: it takes its turn like a band, and not before the chores may run) */
  return cropHonoured(gl, (fn) => chore(fn, 0, tag, { soft: true })).then((ok) => (ok ? inBands() : whole()));
  function inBands() {
    let t = null, rows = Math.min(h, Math.max(FEWEST, Math.floor(BYTES / (w * 4)))), bands = 0, longest = 0, firstCut = 0, firstBand = 0;
    /* (seen once on the laptop in Firefox and not again: a first band of 1012 ms, with the browser's warning that a
       texture made empty is cleared on its first partial upload; every other run cleared in 0-1 ms. Said with the
       bands: how long the first band's own bitmap took to come and how long its copy took, to tell a deferred decode
       from a slow clear if it is ever seen again) */
    /* a band's own bitmap, cut from the picture (off the page's thread) */
    const cut = (y) => {
      const n = Math.min(rows, h - y), c0 = performance.now(), p = createImageBitmap(bitmap, 0, y, w, n, CUT).then((bm) => { if (!y) firstCut = performance.now() - c0; return { y, n, bm }; });
      /* (a cut that fails is said where it is waited for, not before) */
      p.catch(() => {});
      return p;
    };
    /* a band put in, in its own soft chore (the texture made with the first); how long the copy took (ms) */
    const put = ({ y, n, bm }) => chore(() => {
      if (!t) {
        t = gl.createTexture(); gl.bindTexture(T, t);
        gl.texImage2D(T, 0, internal, w, h, 0, format, type, null);
        params(t);
      } else gl.bindTexture(T, t);
      const t0 = performance.now();
      gl.texSubImage2D(T, 0, 0, y, w, n, format, type, bm);
      return performance.now() - t0;
    }, 0, tag, { soft: true }).finally(() => bm.close?.());
    const bandsIn = (async () => {
      let next = cut(0);
      try {
        for (;;) {
          const band = await next;
          /* the next band's bitmap cut while this one waits its turn */
          const end = band.y + band.n;
          next = end < h ? cut(end) : null;
          const ms = await put(band);
          if (!bands++) firstBand = ms;
          if (ms > SLOW) rows = Math.max(FEWEST, rows >> 1);
          longest = Math.max(longest, ms);
          if (!next) break;
        }
      } catch (e) {
        next?.then((b) => b.bm.close?.(), () => {});
        throw e;
      } finally {
        if (!keep) bitmap.close?.();
      }
      if (say()) note(`upload: ${name} ${w}x${h} in ${bands} bands, longest ${longest.toFixed(1)} ms (the first: cut ${firstCut.toFixed(0)} ms, copied ${firstBand.toFixed(1)})`);
      drawable?.(t);
      return t;
    })();
    return mips ? bandsIn.then((tx) => chore(() => { levels(tx); return tx; }, 60, tag)) : bandsIn;
  }
}
