/**
 * The desk's drop zone while a file is dragged over it (#1244), carried from
 * design/v19/create-dragover.html (owner, 2026-10-07: "8a yes") as Fable's
 * build notes on #1244 lay it out. Its own module so the drag states can be
 * driven without the whole form (tests/unit/v19-create-drop-feedback.test.mjs).
 *
 * Two classes on <body>, nothing re-laid out: `dragging` while a file is
 * anywhere over the page (armed: the zone warms, the brackets hang loose,
 * the hint says where to bring it), and `over` while it is over the zone
 * (locked: solid accent, the brackets pull in and breathe, "release to add
 * it"). The drop re-runs the zone's `landed` settle as `body.doc`'s held
 * line takes over. create.css draws all three.
 *
 * THE FLICKER TRAP. dragenter/dragleave bubble from every child the pointer
 * crosses: moving from the zone's padding onto its text fires a dragleave on
 * the zone and a dragenter for the text back to back, and a naive on/off
 * blinks the state off for a frame. So each target keeps a depth: +1 on
 * dragenter, -1 on dragleave, on while above zero, back to zero on drop,
 * dragend, window blur and the first mousemove after a drag (a drag that
 * leaves the window never fires dragleave in some browsers; the pointer just
 * stops reporting until it comes back without a button down).
 *
 * Only a file arms it: a dragged selection or link carries no "Files" type.
 *
 * @param {{
 *   on: ReturnType<typeof import('$lib/teardown.js').screenScope>["on"],
 *   dropzone: HTMLElement | null,
 *   live: HTMLElement | null,
 *   takeFile: (file: File) => void,
 * }} wiring
 * @returns {{ clear: () => void }}  hands every class back; for the screen's teardown
 */
export function wireDropFeedback({ on, dropzone, live, takeFile }) {
  const body = document.body;
  let pageDepth = 0;
  let zoneDepth = 0;
  let frame = 0;

  const hasFiles = (/** @type {DragEvent} */ event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  /** Polite, never assertive; cleared then set on the next frame, so the
      same words said twice are announced twice. */
  function say(/** @type {string} */ text) {
    if (!live) return;
    live.textContent = "";
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { live.textContent = text; });
  }

  function setArmed(/** @type {boolean} */ armed) {
    body.classList.toggle("dragging", armed);
    if (!armed) {
      body.classList.remove("over");
      zoneDepth = 0;
    }
  }

  function setOver(/** @type {boolean} */ over) {
    body.classList.toggle("over", over);
    if (over) say(body.classList.contains("doc") ? "Release to swap the document" : "Release to add the document");
  }

  function clearDrag() {
    pageDepth = 0;
    zoneDepth = 0;
    setArmed(false);
  }

  /* The page: a file over any part of it arms the zone. dragover is
     cancelled everywhere, with "none" off the zone, or the browser opens the
     file when it is let go off-target; an off-target drop is swallowed for
     the same reason. */
  on(document, "dragenter", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    if (pageDepth++ === 0) setArmed(true);
  });
  on(document, "dragleave", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    if (--pageDepth <= 0) clearDrag();
  });
  on(document, "dragover", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer && !dropzone?.contains(/** @type {Node} */ (event.target))) event.dataTransfer.dropEffect = "none";
  });
  on(document, "drop", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    clearDrag();
  });
  on(document, "dragend", clearDrag);
  on(window, "blur", clearDrag);
  on(window, "mousemove", () => { if (pageDepth > 0) clearDrag(); });

  /* The zone itself: lock on. */
  on(dropzone, "dragenter", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    if (zoneDepth++ === 0) setOver(true);
  });
  on(dropzone, "dragleave", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    if (--zoneDepth <= 0) {
      zoneDepth = 0;
      setOver(false);
    }
  });
  on(dropzone, "dragover", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  on(dropzone, "drop", (/** @type {DragEvent} */ event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    clearDrag();
    if (!file || !dropzone) return;
    takeFile(file);
    /* The hand-over settle: re-added each drop (remove, reflow, add) so the
       animation runs again. */
    dropzone.classList.remove("landed");
    void dropzone.offsetWidth;
    dropzone.classList.add("landed");
    say(`${file.name} added. Reading it in the lane on the right.`);
  });

  return {
    clear() {
      cancelAnimationFrame(frame);
      clearDrag();
      dropzone?.classList.remove("landed");
    },
  };
}
