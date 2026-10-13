/*
 * PICTURES DECODED BEFORE THEY ARE SHOWN (Orbit's #1299).
 *
 * The dusk's full-screen pictures load when the sign-out starts but sit
 * invisible until the dusk beat (3.6 s), and a browser decodes a picture
 * only when it is first drawn, so Firefox decoded all of them in the frames
 * where the dusk fades in. Asking for each to be decoded as soon as it is
 * wanted moves that work off the beat and off the page's own thread:
 * `decode()` decodes in the background, and the decoded picture is shared
 * with every element showing the same address. The pictures are held until
 * the caller lets them go, so the browser does not throw the decoded copies
 * away first.
 */

/**
 * @param {string[]} urls
 * @param {() => HTMLImageElement} [make]
 * @returns {{ ready: Promise<void>, held: HTMLImageElement[] }}
 *   ready: every picture decoded, or failed to (a failure is not an error
 *   here: the element showing it reports its own)
 */
export function decodeAhead(urls, make = () => new Image()) {
  const held = urls.map((url) => {
    const picture = make();
    picture.decoding = "async";
    picture.src = url;
    return picture;
  });
  const ready = Promise.all(held.map((picture) =>
    (typeof picture.decode === "function" ? picture.decode() : Promise.resolve()).catch(() => {}),
  )).then(() => {});
  return { ready, held };
}
