import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Separate build output when needed (e.g. a verification build while `next dev` uses .next)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@diorama/engine", "@diorama/plugins", "@diorama/ui", "@diorama/ops"],
  serverExternalPackages: ["ws", "read-excel-file", "unpdf"],
};

export default nextConfig;
