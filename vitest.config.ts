import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Added for UG-CR-RPT-030 correction 2: route files under app/api/ import
 * their dependencies via the "@/" path alias (tsconfig.json's own
 * "paths" mapping, otherwise resolved only by Next.js's own SWC build).
 * Plain Vitest does not read tsconfig "paths" on its own, so no route
 * file with a real internal import could previously be imported by a
 * test at all — confirmed repo-wide: the one prior route import in
 * __tests__/gamingConfigRoute.test.ts only works because that specific
 * route has zero internal imports. This file is additive only (an
 * alias resolution rule); it changes no test's behavior unless that
 * test imports something through "@/".
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
