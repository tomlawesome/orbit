import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orbit",
    short_name: "Orbit",
    description: "Everything in your orbit, on track.",
    start_url: "/",
    display: "standalone",
    background_color: "#111229",
    theme_color: "#15162b",
    orientation: "portrait-primary",
    icons: [
      { src: "/orbit-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/orbit-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
