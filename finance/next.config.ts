import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * pdfjs-dist loads its worker by resolving a sibling file at runtime. Bundled
   * into a server chunk, that path no longer exists and every upload fails with
   * "Setting up fake worker failed". Opting it out makes Node resolve it
   * normally from node_modules.
   *
   * better-sqlite3 is already on Next's built-in external list, so it needs no
   * entry here.
   */
  serverExternalPackages: ["pdfjs-dist"],

  /**
   * The packaged desktop app (desktop/scripts/stage-server.js) ships a
   * self-contained server. Only that build asks for it, so `next start` here
   * keeps working as before.
   */
  output: process.env.FINANCE_STANDALONE ? "standalone" : undefined,
  // The same worker, for that build: it is loaded by path at runtime, so file
  // tracing cannot see it, and without it every upload fails.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
