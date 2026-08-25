import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const MANAGER_DIR = join(ROOT_DIR, "apps", "longhub-manager");
const pnpmEntry = process.env.npm_execpath;

function run(args) {
  const command = pnpmEntry ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commandArgs = pnpmEntry ? [pnpmEntry, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
    shell: !pnpmEntry && process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCloudTests(files) {
  run(["--filter", "longhub-cloud-api", "exec", "vitest", "run", ...files]);
}

function runPackageTests(packageName, files = []) {
  run(["--filter", packageName, "exec", "vitest", "run", ...files]);
}

function managerGoTest({ required }) {
  const command = process.platform === "win32" ? "go.exe" : "go";
  const probe = spawnSync(command, ["version"], {
    cwd: MANAGER_DIR,
    encoding: "utf8",
    env: process.env,
    shell: false,
  });
  const versionMatch = probe.stdout?.match(/\bgo(\d+)\.(\d+)(?:\.\d+)?\b/);
  const supported = versionMatch &&
    (Number(versionMatch[1]) > 1 || Number(versionMatch[2]) >= 24);
  if (probe.error || probe.status !== 0 || !supported) {
    if (required) {
      console.error("Go 1.24+ 不可用；clean-launch Manager 检查不能跳过。请先安装 Go。\n");
      process.exit(1);
    }
    console.warn("跳过 LongHub Manager Go 检查：当前环境未发现 Go（本地 pnpm tier 不因此失败）。\n");
    return;
  }

  const result = spawnSync(command, ["test", "./..."], {
    cwd: MANAGER_DIR,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tier = process.argv[2];
const startedAt = Date.now();

switch (tier) {
  case "unit-contract":
    // The workspace has already excluded the historical Electron/Pack tree.
    // Turbo therefore exercises only current JS/TS contracts; Portal has no
    // test script yet, so its typecheck is an explicit contract gate.
    run(["--filter", "longhub-portal", "typecheck"]);
    run(["turbo", "run", "test", "--concurrency=50%"]);
    managerGoTest({ required: false });
    break;
  case "smoke":
    run(["turbo", "run", "build", "--concurrency=50%"]);
    runCloudTests([
      "test/clean-launch.test.ts",
      "test/cloud-skill-adapter-distribution.test.ts",
      "test/cloud-skill-execution.test.ts",
      "test/cloud-skill-billing.test.ts",
      "test/executor-response-boundary.test.ts",
    ]);
    runPackageTests("@longhub/openclaw-cloud-plugin", ["test/plugin.test.ts"]);
    runPackageTests("@longhub/cloud-skill-adapter", ["test/index.test.ts"]);
    managerGoTest({ required: false });
    break;
  case "security":
    run(["turbo", "run", "build", "--concurrency=50%"]);
    run(["--filter", "@longhub/feature-policy", "test"]);
    run(["--filter", "@longhub/observability", "test"]);
    runCloudTests([
      "test/edge-rate-limit.test.ts",
      "test/feature-policy.test.ts",
      "test/logging-redaction.test.ts",
      "test/executor-response-boundary.test.ts",
      "test/cloud-skill-execution.test.ts",
      "test/cloud-skill-billing.test.ts",
      "test/task-ownership.test.ts",
      "test/task-fingerprint.test.ts",
    ]);
    managerGoTest({ required: false });
    break;
  case "full":
    run(["turbo", "run", "test", "--concurrency=50%"]);
    managerGoTest({ required: false });
    break;
  case "manager-test":
    // CI invokes this tier after setup-go. It is intentionally separate so a
    // developer's ordinary pnpm test remains useful on a Node-only machine.
    managerGoTest({ required: true });
    break;
  default:
    throw new Error("CI tier 必须是 unit-contract、smoke、security、full 或 manager-test");
}

const durationSeconds = Math.ceil((Date.now() - startedAt) / 1_000);
process.stdout.write(JSON.stringify({ event: "ci.tier.completed", tier, duration_seconds: durationSeconds }) + "\n");
