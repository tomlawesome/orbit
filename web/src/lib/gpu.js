/*
 * WHETHER THIS PAGE MAY USE THE GPU AT ALL (#1371 spec item 11, orbit-site
 * ADR-0002). The answer is the shared door's: it tests the GPU on every
 * visit, from one WebGL2 context, and remembers nothing between visits (the
 * folder's README, "The GPU gate"). Orbit's own code that needs the answer,
 * such as the dial's sun, asks here and nowhere else, so there is one place
 * that names where the answer comes from.
 *
 * `gpu()` is `{ canvas, gl, parallel, renderer }`, or `null` where the
 * browser declines the context or the renderer is software.
 */
export { gpu } from "$lib/door/index.js";
