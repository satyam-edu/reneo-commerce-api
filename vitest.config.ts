import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These suites share one live Supabase project; running test files in
    // parallel risks interleaved Auth admin calls and cross-suite data
    // races that have nothing to do with the app logic being tested.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
