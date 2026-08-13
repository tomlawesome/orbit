import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orbit",
    short_name: "Orbit",
    description: "Everything in your orbit, on track.",
    start_url: "/",
    display: "standalone",
    // Star-chart, the default theme pack (theme-tokens.css) — the retired
    // #111229/#15162b pair belonged to the retired three-arc identity.
    background_color: "#060b1c",
    theme_color: "#060b1c",
    orientation: "portrait-primary",
    // "any" only: the ratified mark's planet rides the ring out to 89% of the
    // radius, past the maskable safe zone, and a plate behind it would be a
    // fourth shape the mark is not allowed to have.
    icons: [{ src: "/orbit-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
