import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyBrandAssets, verifyRelease } from "./release-verification.mjs";
import { verifyExternalRuntimeManifest } from "./openclaw-runtime-manifest.mjs";

function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workspaceRoot = resolve(packageRoot, "..", "..");
  const stageRoot = resolve(workspaceRoot, ".release-stage", "desktop");
  const expectedStageRoot = resolve(workspaceRoot, ".release-stage", "desktop");
  if (stageRoot !== expectedStageRoot || !stageRoot.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("发布暂存目录越界");
  }
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "public";
  if (!new Set(["internal", "public"]).has(mode)) throw new Error(`未知发布模式: ${mode}`);
  if (process.platform !== "win32") throw new Error("Windows 安装包只能在 Windows 构建机生成");

  verifyBrandAssets(packageRoot, { requireApproved: mode === "public" });
  verifyExternalRuntimeManifest(packageRoot);
  if (mode === "public" && !process.env.LONGHUB_EXPECTED_SIGNER_SUBJECT?.trim()) {
    throw new Error("正式发布必须设置 LONGHUB_EXPECTED_SIGNER_SUBJECT，并向 electron-builder 提供签名证书");
  }

  const env = { ...process.env };
  if (mode === "internal" && !env.CSC_LINK && !env.WIN_CSC_LINK) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const cleanStage = () => {
    if (existsSync(stageRoot)) {
      rmSync(stageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
  cleanStage();
  try {
    const pnpmCli = process.env.npm_execpath;
    const deploy = pnpmCli
      ? spawnSync(process.execPath, [
          pnpmCli,
          "--filter",
          "longhub-desktop",
          "deploy",
          "--prod",
          "--legacy",
          "--force",
          stageRoot,
        ], { cwd: workspaceRoot, env, stdio: "inherit", windowsHide: true })
      : spawnSync("pnpm.cmd", [
          "--filter",
          "longhub-desktop",
          "deploy",
          "--prod",
          "--legacy",
          "--force",
          stageRoot,
        ], { cwd: workspaceRoot, env, stdio: "inherit", windowsHide: true });
    if (deploy.status !== 0) throw new Error(`发布依赖暂存失败，退出码 ${deploy.status ?? 1}`);
    const stagedPackagePath = resolve(stageRoot, "package.json");
    const stagedPackage = JSON.parse(readFileSync(stagedPackagePath, "utf8"));
    delete stagedPackage.build;
    delete stagedPackage.devDependencies;
    delete stagedPackage.scripts;
    delete stagedPackage.files;
    writeFileSync(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
    env.LONGHUB_RELEASE_APP_DIR = stageRoot;
    const require = createRequire(import.meta.url);
    const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");
    const build = spawnSync(process.execPath, [
        electronBuilderCli,
        "--win",
        "nsis",
        "--config",
        "electron-builder.config.mjs",
        "--publish",
        "never",
      ], {
        cwd: packageRoot,
        env,
        stdio: "inherit",
        windowsHide: true,
      });
    if (build.status !== 0) throw new Error(`electron-builder 失败，退出码 ${build.status ?? 1}`);
  } finally {
    cleanStage();
  }

  const result = verifyRelease({ packageRoot, mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Windows 发布构建失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
