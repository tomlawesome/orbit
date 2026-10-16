/**
 * The About page's fixture bodies (#1256, ORBIT_FIXTURES only): what the
 * pixel gate photographs, so the screen has the same facts on every run.
 */

/** The gate's body for `GET /api/about`: one of each row state. */
export const ABOUT_FIXTURE = {
  build: {
    version: "0.3.0",
    channel: "preview",
    revision: "fd6a7e6c0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    image: "sha256:3f9d2c4b8a7e6d5c4b3a2918f7e6d5c4b3a29180f7e6d5c4b3a2918f7e6d5c4b",
  },
  node: "v24.11.0",
  sidecars: [
    { id: "postgres", state: "running", version: "18.0" },
    { id: "tika", state: "running", version: "4.1.0" },
    { id: "clamav", state: "running", version: null },
    { id: "ollama", state: "off", version: null },
  ],
};

/**
 * The gate's libraries, in place of a release build's bill of materials: a
 * development build has none, and the screen is photographed with rows in
 * it. Real shipped packages, at the shape `readLibraries` gives.
 */
export const LIBRARIES_FIXTURE = [
  { name: "@napi-rs/canvas", version: "1.0.9", licence: "MIT", author: "", source: "https://github.com/Brooooooklyn/canvas" },
  { name: "drizzle-orm", version: "0.45.2", licence: "Apache-2.0", author: "Drizzle Team", source: "https://orm.drizzle.team/" },
  { name: "imapflow", version: "2.0.2", licence: "MIT", author: "Postal Systems OÜ", source: "https://imapflow.com/" },
  { name: "jose", version: "6.2.12", licence: "MIT", author: "Filip Skokan", source: "https://github.com/panva/jose" },
  { name: "pdfjs-dist", version: "6.3.289", licence: "Apache-2.0", author: "", source: "https://mozilla.github.io/pdf.js/" },
  { name: "postgres", version: "3.4.9", licence: "Unlicense", author: "Rasmus Porsager", source: "https://github.com/porsager/postgres" },
  { name: "web-push", version: "3.6.7", licence: "MPL-2.0", author: "Marco Castelluccio", source: "https://github.com/web-push-libs/web-push#readme" },
  { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", source: "https://zod.dev/" },
];
