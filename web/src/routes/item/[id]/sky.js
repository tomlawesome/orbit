/**
 * The item view's starfield IS home's (#445): same seed, same layers, drawn by
 * the shared generator, so "the same sky seen from another page" is true by
 * construction rather than by parallel maintenance. POL-11's drift comes from
 * the shared atmosphere.css keyframes.
 */
import { mountTiledSky } from "$lib/sky.js";

export const mountItemSky = (root) => mountTiledSky(root, "item");
