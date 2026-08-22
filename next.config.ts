import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  experimental: { optimizePackageImports: ["drizzle-orm"] },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/**/*",
      // The Liberation/Foxit substitutes for the standard 14 fonts, read from
      // disk when a page-one preview renders text a document did not embed
      // (#476). Shipped inside pdfjs-dist, so this adds no dependency.
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-musl/**/*",
    ],
  },
};

export default nextConfig;
