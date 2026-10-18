import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (embedded Postgres used in demo mode) ships WASM + data files and
  // must be loaded by Node at runtime rather than bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  // SQL migrations are read from disk at runtime by the demo database.
  outputFileTracingIncludes: {
    "/**": ["./supabase/migrations/**/*", "./db/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
