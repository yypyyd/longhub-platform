import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep retired Pack/SkillPackage regressions runnable without making a shell
// specific environment assignment part of the documented workflow.
const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [
  vitestEntry,
  "run",
  "test/pack-distribution.test.ts",
  "test/skill-catalog.test.ts",
  "test/contract.test.ts",
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  env: { ...process.env, LONGHUB_RUN_LEGACY_SURFACE_TESTS: "true" },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
