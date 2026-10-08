// The door's and the dusk's glow pictures (web/static/flight/{door,dusk}/
// glow-*.webp), drawn without banding.
//
// The graphs are orbit-site's (assets/js/flight.js: DAWN, DUSK), copied here
// unchanged; orbit-site's tools/glows.cjs draws the same graphs into an 8-bit
// canvas and saves them as lossy WebP. These glows are faint: the dusk's glow
// peaks at 14/255 opacity, so an 8-bit drawing holds 14 steps across the whole
// sky and each step shows as a stripe (owner, 2026-10-07).
//
// Standard pattern: dither from a high-precision source before quantising to
// 8 bits. The browser only draws filters at 8 bits, so the high-precision
// source is merged from exposure brackets, as an HDR photograph is: every
// opacity in the graph is multiplied by 1, 2, 4 … 32, and each pixel takes the
// brightest exposure that is neither saturated nor inconsistent with the one
// below it, divided back down. Blurs and opacities are linear, so a brighter
// exposure is the same picture with more steps; where overlapping shapes
// make it non-linear, the consistency check keeps the dimmer exposure. The
// merged opacity is error-diffused (Floyd–Steinberg) to 8 bits and saved
// lossless:
// lossy WebP would smooth the dither straight back into stripes.
//
// Usage: node scripts/flight-glows.mjs [--out dir]   (needs python3 with Pillow)
//   default out: web/static/flight

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const F_B6L = '<filter id="b6l" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
const F_B20L = '<filter id="b20l" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1800" height="1200"><feGaussianBlur stdDeviation="20"/></filter>';
const F_RAYROUGH = '<filter id="rayrough" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.03" numOctaves="2" seed="9" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="22"/><feGaussianBlur stdDeviation="17"/></filter>';
const G_ZOD = '<radialGradient id="zod" cx="50%" cy="88%" r="75%"><stop offset="0%" stop-color="#f6d489" stop-opacity=".13"/><stop offset="55%" stop-color="#e8b25e" stop-opacity=".045"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
const G_RAYG = '<linearGradient id="rayg" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ffe4a8" stop-opacity=".26"/><stop offset="55%" stop-color="#f4c05a" stop-opacity=".07"/><stop offset="100%" stop-opacity="0"/></linearGradient>';
const F_DB6 = '<filter id="d-b6" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
const F_DB14 = '<filter id="d-b14" filterUnits="userSpaceOnUse" x="-80" y="-80" width="1760" height="1160"><feGaussianBlur stdDeviation="14"/></filter>';
const F_DB24 = '<filter id="d-b24" filterUnits="userSpaceOnUse" x="-120" y="-120" width="1840" height="1240"><feGaussianBlur stdDeviation="24"/></filter>';
const G_DRIM = '<linearGradient id="d-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f0a35a"/><stop offset="100%" stop-color="#7a2c18"/></linearGradient>';
const G_DGLOW = '<radialGradient id="d-glow" cx="50%" cy="100%" r="60%"><stop offset="0%" stop-color="#e2772b" stop-opacity=".28"/><stop offset="60%" stop-color="#7a2c18" stop-opacity=".08"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
const G_DBELT = '<linearGradient id="d-belt" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5a3a7a" stop-opacity="0"/><stop offset="50%" stop-color="#a24d6a" stop-opacity=".18"/><stop offset="100%" stop-color="#e2772b" stop-opacity="0"/></linearGradient>';

/**
 * Scale against the 1600×1000 frame. orbit-site draws the softest at half
 * size, which a blur that wide cannot tell apart; but stretched to the frame
 * a dither drawn at half size is averaged back into steps, so the dusk's are
 * drawn at full size, for about what its lossy half-size files weighed. The
 * door's stay at half size: drawn full size they would add 270 KB to the
 * sign-in, and its glows show little banding (2026-10-08 comparison).
 */
export const GLOWS = [
  { set: "door", name: "zod", k: 0.5, defs: F_B20L + G_ZOD, body: '<ellipse cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>' },
  {
    set: "door", name: "sway1", k: 0.5, defs: F_RAYROUGH + G_RAYG,
    body: '<g fill="url(#rayg)" filter="url(#rayrough)">' +
      '<path d="M 800 924 L 736 356 L 772 362 Z"/><path d="M 800 924 L 852 528 L 892 548 Z"/><path d="M 800 924 L 508 620 L 556 588 Z"/>' +
      '<path d="M 800 924 L 1096 448 L 1052 428 Z"/><path d="M 800 924 L 320 690 L 360 646 Z" opacity=".8"/><path d="M 800 924 L 1290 670 L 1244 630 Z" opacity=".8"/></g>',
  },
  {
    set: "door", name: "sway2", k: 0.5, defs: F_RAYROUGH + G_RAYG,
    body: '<g fill="url(#rayg)" filter="url(#rayrough)" opacity=".7">' +
      '<path d="M 800 924 L 646 404 L 680 390 Z"/><path d="M 800 924 L 962 560 L 928 544 Z"/><path d="M 800 924 L 404 610 L 448 574 Z"/><path d="M 800 924 L 1200 596 L 1156 562 Z"/></g>',
  },
  { set: "door", name: "sunpt", k: 1.5, defs: F_B6L, body: '<circle cx="800" cy="919" r="20" fill="#fffdf6" filter="url(#b6l)"/>' },
  { set: "dusk", name: "glow", k: 1, defs: F_DB24 + G_DGLOW, body: '<ellipse cx="800" cy="960" rx="900" ry="380" fill="url(#d-glow)" filter="url(#d-b24)"/>' },
  { set: "dusk", name: "belt", k: 1, defs: F_DB24 + G_DBELT, body: '<rect x="0" y="560" width="1600" height="360" fill="url(#d-belt)" filter="url(#d-b24)"/>' },
  {
    set: "dusk", name: "afterglow", k: 1, defs: F_DB24 + F_DB14 + F_DB6,
    body: '<circle cx="800" cy="3920" r="3080" fill="none" stroke="#7a2c18" stroke-opacity=".14" stroke-width="120" filter="url(#d-b24)"/>' +
      '<circle cx="800" cy="3920" r="3030" fill="none" stroke="#c2571f" stroke-opacity=".18" stroke-width="44" filter="url(#d-b14)"/>' +
      '<circle cx="800" cy="3920" r="3008" fill="none" stroke="#f0a35a" stroke-opacity=".28" stroke-width="10" filter="url(#d-b6)"/>',
  },
  { set: "dusk", name: "rim", k: 1.5, defs: F_DB6 + G_DRIM, body: '<circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)" stroke-width="5" stroke-opacity=".3" filter="url(#d-b6)"/>' },
];

export const GAINS = [1, 2, 4, 8, 16, 32];

/** Every opacity in an SVG fragment multiplied by `gain` (the browser clamps at 1). */
export function brighten(svg, gain) {
  return svg.replace(/((?:stop-|stroke-|fill-)?opacity)="([0-9.]+)"/g, (_, attr, value) => `${attr}="${Number(value) * gain}"`);
}

/**
 * One high-precision RGBA picture (0–255 floats, unpremultiplied) from 8-bit
 * exposures of the same picture, unpremultiplied as getImageData gives them,
 * one per entry of `gains` (ascending, the first 1). Each pixel climbs to the
 * next exposure only while that exposure is unsaturated there and its opacity
 * agrees with the current estimate to within one of its steps: the source is
 * rounded too before it is blurred, so exposures differ by a little more than
 * their own rounding, while a saturated one differs by far more.
 * Opacity alone decides: filters blur in linearRGB, so a faint pixel's colour
 * is rounded in linear light and disagrees between exposures by more than
 * that. The colour is the brightest accepted exposure's, which is the most
 * precise, as the unpremultiplied colour does not change with the gain.
 * @param {ArrayLike<number>[]} exposures
 * @param {number[]} gains
 */
export function mergeExposures(exposures, gains) {
  const size = exposures[0].length;
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 4) {
    let chosen = 0;
    let alpha = exposures[0][i + 3] / gains[0];
    for (let e = 1; e < gains.length; e++) {
      const a = exposures[e][i + 3];
      if (a >= 255) break;
      const next = a / gains[e];
      if (Math.abs(next - alpha) > 1 / gains[chosen] + 1e-9) break;
      alpha = next;
      chosen = e;
    }
    for (let c = 0; c < 3; c++) out[i + c] = exposures[chosen][i + c];
    out[i + 3] = alpha;
  }
  return out;
}

/** Below a quarter of a step a glow is invisible; dithering it only scatters dots over the whole file. */
const FLOOR = 0.25;

/**
 * Floyd–Steinberg (serpentine) on the opacity, from floats to 8 bits. The
 * colour stays as it is: the browser premultiplies it by the dithered
 * opacity on decode, so the composited colour carries the same dither, and a
 * smooth colour channel keeps the lossless file small.
 * @param {Float64Array} merged
 * @param {number} width
 * @param {number} height
 */
export function ditherToRgba(merged, width, height) {
  const alpha = new Float64Array(width * height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = merged[p * 4 + 3] < FLOOR ? 0 : merged[p * 4 + 3];
  const rgba = new Uint8ClampedArray(merged.length);
  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0, step = leftToRight ? 1 : -1;
    for (let n = 0; n < width; n++) {
      const x = leftToRight ? n : width - 1 - n, p = y * width + x;
      const value = Math.min(255, Math.max(0, Math.round(alpha[p])));
      const error = alpha[p] - value;
      if (x + step >= 0 && x + step < width) alpha[p + step] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x - step >= 0 && x - step < width) alpha[p + width - step] += (error * 3) / 16;
        alpha[p + width] += (error * 5) / 16;
        if (x + step >= 0 && x + step < width) alpha[p + width + step] += error / 16;
      }
      rgba[p * 4 + 3] = value;
      for (let c = 0; c < 3; c++) rgba[p * 4 + c] = value === 0 ? 0 : merged[p * 4 + c];
    }
  }
  return rgba;
}

/**
 * Lossless WebP through Pillow's libwebp at its slowest, smallest setting.
 * Chromium's own encoder (toDataURL quality 1) is lossless too, but its files
 * are up to seventy times larger.
 * @param {Buffer} rgba unpremultiplied
 * @param {number} width
 * @param {number} height
 * @param {string} file
 */
function encodeLossless(rgba, width, height, file) {
  const program = "import sys\nfrom PIL import Image\nw, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]\n" +
    "Image.frombytes('RGBA', (w, h), sys.stdin.buffer.read()).save(out, 'WEBP', lossless=True, quality=100, method=6)\n";
  execFileSync("python3", ["-c", program, String(width), String(height), file], { input: rgba, stdio: ["pipe", "inherit", "inherit"] });
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outRoot = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(repositoryRoot, "web/static/flight");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<!doctype html><meta charset=utf-8>");
  // The whole pipeline runs in the page: pictures this size are too slow to
  // carry across the protocol as arrays.
  await page.addScriptTag({ content: `${brighten}\n${mergeExposures}\n${ditherToRgba}\nconst GAINS = ${JSON.stringify(GAINS)};\nconst FLOOR = ${FLOOR};
    async function drawGlow({ defs, body }, w, h) {
      // a graph with no opacity to raise (the sun's opaque point) has one exposure
      const gains = brighten(defs + body, 2) === defs + body ? [1] : GAINS;
      const exposures = [];
      for (const gain of gains) {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 1600 1000"><defs>' + brighten(defs, gain) + '</defs>' + brighten(body, gain) + '</svg>';
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0, w, h);
        exposures.push(context.getImageData(0, 0, w, h).data);
      }
      const rgba = ditherToRgba(mergeExposures(exposures, gains), w, h);
      let binary = "";
      for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
      return btoa(binary);
    }` });
  for (const glow of GLOWS) {
    const w = Math.round(1600 * glow.k), h = Math.round(1000 * glow.k);
    const rgba = await page.evaluate(([g, ww, hh]) => /** @type {any} */ (window).drawGlow(g, ww, hh), [glow, w, h]);
    const file = join(outRoot, glow.set, `glow-${glow.name}.webp`);
    mkdirSync(dirname(file), { recursive: true });
    encodeLossless(Buffer.from(rgba, "base64"), w, h, file);
    console.log(`wrote ${glow.set}/glow-${glow.name}.webp ${w}x${h} ${Math.round(statSync(file).size / 1024)} KB`);
  }
  await browser.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
