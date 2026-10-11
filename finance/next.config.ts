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
};

export default nextConfig;
