import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // DB integration tests each create an isolated in-memory Postgres (PGlite).
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // Deterministic timezone for all date logic (app runs in IST).
    env: { TZ: "Asia/Kolkata", SHG_SCHEDULER: "off" },
    restoreMocks: true,
    unstubGlobals: true,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "coverage/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Business logic layer. UI components/pages are rendered by Next.js and
      // verified by lint/typecheck/build + smoke tests, not unit tests.
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/*.d.ts",
        "src/lib/i18n/en.ts", // translation data, not logic
        "src/lib/i18n/hi.ts",
        "src/lib/supabase/**", // thin wrappers around the Supabase SDK (live service only)
      ],
    },
  },
});
