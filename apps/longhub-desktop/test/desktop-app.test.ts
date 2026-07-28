import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  computePackDigest,
  signPackDigest,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
import { CoreClient } from "../src/core-client.js";
import { DesktopApp } from "../src/desktop-app.js";
import { PackInstaller } from "../src/pack-installer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "longhub-release-2026-01";

const workDir = mkdtempSync(join(tmpdir(), "longhub-desktop-app-"));
const corePath = fileURLToPath(new URL("../dist/core-process.js", import.meta.url));

const core = new CoreClient({ corePath });
const installer = new PackInstaller(join(workDir, "packs"));
const app = new DesktopApp(core, installer, {
  trustedKeys: new Map([[KEY_ID, publicPem]]),
  desktopVersion: "1.0.0",
});
app.start();

afterAll(() => {
  app.stop();
  rmSync(workDir, { recursive: true, force: true });
});

function buildPackFile(version: string): PackFile {
  const files = { "agent.yaml": "id: hr" };
  const digest = computePackDigest(files);
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: "longhub.hr-suite", version, minDesktopVersion: "1.0.0" },
    agentTemplate: { id: "longhub.agent.hr", version: "1.0.0" },
    capabilities: [
      { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
    ],
    runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest, signatureKeyId: KEY_ID },
  };
  return { manifest, files, signature: signPackDigest(digest, privatePem) };
}

async function waitForTerminal(taskId: string): Promise<{ status: string; output?: unknown }> {
  for (let i = 0; i < 100; i++) {
    const task = (await app.getTask(taskId)) as { status: string; output?: unknown };
    if (!["pending", "running"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("任务超时未到终态");
}

describe("Desktop 应用服务（Electron 壳的 IPC 后端）", () => {
  it("core.hello 返回 Core RPC 版本", async () => {
    const hello = (await app.hello()) as { coreRpcVersion: string };
    expect(hello.coreRpcVersion).toBe("1.0");
  }, 20_000);

  it("本地技能任务闭环 + 任务事件", async () => {
    const events: string[] = [];
    const off = app.onTaskEvent((event) => events.push(event.type));
    const result = await app.submitTask({
      idempotencyKey: "app-1",
      skillId: "longhub.skill.echo-upper",
      input: { text: "longhub" },
    });
    expect("taskId" in result).toBe(true);
    const task = await waitForTerminal((result as { taskId: string }).taskId);
    off();
    expect(task.status).toBe("succeeded");
    expect(task.output).toEqual({ text: "LONGHUB" });
    expect(events).toContain("task.accepted");
    expect(events).toContain("task.succeeded");
  }, 20_000);

  it("敏感权限未经确认不提交，确认后放行", async () => {
    const blocked = await app.submitTask({
      idempotencyKey: "app-2",
      skillId: "longhub.skill.echo-upper",
      input: { text: "x" },
      grantedPermissions: ["connector:hr-api:write"],
    });
    expect(blocked).toEqual({ needsConfirmation: ["connector:hr-api:write"] });

    const confirmed = await app.submitTask({
      idempotencyKey: "app-2",
      skillId: "longhub.skill.echo-upper",
      input: { text: "x" },
      grantedPermissions: ["connector:hr-api:write"],
      userConfirmed: true,
    });
    expect("taskId" in confirmed).toBe(true);
    const task = await waitForTerminal((confirmed as { taskId: string }).taskId);
    expect(task.status).toBe("succeeded");
  }, 20_000);

  it("从制品文件安装套装并列出", () => {
    const packPath = join(workDir, "hr-suite.pack.json");
    writeFileSync(packPath, JSON.stringify(buildPackFile("1.0.0")), "utf-8");
    const result = app.installPackFromFile(packPath);
    expect(result).toMatchObject({ ok: true, packId: "longhub.hr-suite", version: "1.0.0" });
    expect(app.listPacks()).toEqual([
      { packId: "longhub.hr-suite", activeVersion: "1.0.0", previousVersion: undefined },
    ]);
  });

  it("升级后可回滚", () => {
    const packPath = join(workDir, "hr-suite-2.pack.json");
    writeFileSync(packPath, JSON.stringify(buildPackFile("2.0.0")), "utf-8");
    expect(app.installPackFromFile(packPath)).toMatchObject({ ok: true, version: "2.0.0" });
    expect(app.rollbackPack("longhub.hr-suite")).toMatchObject({ ok: true, version: "1.0.0" });
  });

  it("HR 本地技能：简历初筛闭环", async () => {
    const result = await app.submitTask({
      idempotencyKey: "app-hr-1",
      skillId: "longhub.skill.resume-screen",
      input: { requiredKeywords: ["typescript"], resumeText: "精通 TypeScript" },
      grantedPermissions: ["connector:hr-api:read"],
    });
    expect("taskId" in result).toBe(true);
    const task = await waitForTerminal((result as { taskId: string }).taskId);
    expect(task.status).toBe("succeeded");
    expect(task.output).toMatchObject({ score: 100, recommendation: "pass" });
  }, 20_000);

  it("HR 底座技能：JD 起草经适配层（Mock 底座）闭环", async () => {
    const result = await app.submitTask({
      idempotencyKey: "app-hr-2",
      skillId: "longhub.skill.jd-draft",
      input: { position: "招聘专员", mustHaves: ["沟通能力"] },
      grantedPermissions: ["connector:hr-api:read"],
    });
    expect("taskId" in result).toBe(true);
    const task = await waitForTerminal((result as { taskId: string }).taskId);
    expect(task.status).toBe("succeeded");
    expect((task.output as { jd: string }).jd).toContain("招聘专员");
  }, 20_000);

  it("损坏的制品文件返回错误而不是抛异常", () => {
    const packPath = join(workDir, "broken.pack.json");
    writeFileSync(packPath, "{not json", "utf-8");
    expect(app.installPackFromFile(packPath)).toMatchObject({ ok: false, code: "PACK_FILE_INVALID" });
  });
});
