/**
 * Pins a streamed backdrop's sky layer to the viewport (#1689). The create,
 * relay and administration backdrops build their own `.sky` element, which
 * PageSky's scoped style cannot reach and which no route stylesheet may name,
 * so the layer carries its own geometry, the values the three sheets wrote.
 * @param {HTMLElement} skyDiv the layer
 * @param {SVGSVGElement} svg its svg
 */
export function pinSky(skyDiv, svg) {
  Object.assign(skyDiv.style, {
    position: "fixed", inset: "0", pointerEvents: "none",
    opacity: "var(--stars)", transition: "opacity .4s", zIndex: "0",
  });
  Object.assign(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
}
