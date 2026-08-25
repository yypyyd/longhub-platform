/**
 * 全链路端到端集成测试（真实各端实现，仅进程内起服务）：
 * Console 发布（云端签名）→ 设备注册 → 未授权拒绝 → 授权 → 下载验签安装 → 本地执行 HR 技能。
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "longhub-cloud-api";
import { PackPublisher } from "longhub-console";
import { buildHrPackSource, HR_PACK_ID } from "@longhub/hr-suite";
import { CoreClient } from "../src/core-client.js";
import { DesktopApp } from "../src/desktop-app.js";
import { CloudPackClient } from "../src/pack-distribution.js";
import { PackInstaller } from "../src/pack-installer.js";
import { activateCloudDevice } from "./helpers/activate-cloud-device.js";

const ADMIN_TOKEN = "e2e-admin";
/** Retired Pack distribution E2E; excluded from the clean-launch default suite. */
const RUN_LEGACY_SURFACE_TESTS = process.env.LONGHUB_RUN_LEGACY_SURFACE_TESTS === "true";
const workDir = mkdtempSync(join(tmpdir(), "lh-e2e-"));
const corePath = fileURLToPath(new URL("../dist/core-process.js", import.meta.url));

let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let app: DesktopApp;

beforeAll(async () => {
  if (!RUN_LEGACY_SURFACE_TESTS) return;
  // Historical Pack/activation regression only. Clean-launch production keeps
  // these routes unavailable unless a test explicitly opts in.
  api = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    legacySurfaceEnabled: true,
  }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  app = new DesktopApp(new CoreClient({ corePath }), new PackInstaller(join(workDir, "packs")), {
    trustedKeys: new Map(),
    desktopVersion: "1.0.0",
  });
});

afterAll(() => {
  if (RUN_LEGACY_SURFACE_TESTS) {
    app.stop();
    api.close();
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function waitForTerminal(taskId: string): Promise<{ status: string; output?: unknown }> {
  for (let i = 0; i < 100; i++) {
    const task = (await app.getTask(taskId)) as { status: string; output?: unknown };
    if (!["pending", "running"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("任务超时未到终态");
}

describe.skipIf(!RUN_LEGACY_SURFACE_TESTS)(
  "历史 Pack 回归：发布→授权→安装→执行 全链路（仅显式 LONGHUB_RUN_LEGACY_SURFACE_TESTS=true）",
  () => {
  let deviceId: string;
  let deviceToken: string;

  it("Console 上传 HR 套装，云端签名发布", async () => {
    const result = await new PackPublisher(baseUrl, ADMIN_TOKEN).publish(buildHrPackSource("1.0.0"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.release).toMatchObject({ pack_id: HR_PACK_ID, status: "active" });
  });

  it("设备注册后未授权下载被拒", async () => {
    const client = new CloudPackClient(baseUrl);
    const cred = await client.registerDevice({ appVersion: "1.0.0", deviceFingerprint: "e2e-fp" });
    deviceId = cred.deviceId;
    deviceToken = cred.deviceToken;
    await activateCloudDevice(baseUrl, ADMIN_TOKEN, deviceToken);

    const denied = await client.downloadPack(deviceToken, HR_PACK_ID);
    expect(denied).toMatchObject({ ok: false, code: "NOT_ENTITLED" });
  });

  it("授权后下载验签安装成功", async () => {
    const grant = await fetch(`${baseUrl}/v1/admin/entitlements`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, pack_id: HR_PACK_ID }),
    });
    expect(grant.status).toBe(201);

    const installed = await app.installPackFromCloud({ baseUrl, packId: HR_PACK_ID, deviceToken });
    expect(installed).toMatchObject({ ok: true, packId: HR_PACK_ID, version: "1.0.0" });
    expect(app.listPacks()).toEqual([
      { packId: HR_PACK_ID, activeVersion: "1.0.0", previousVersion: undefined },
    ]);
  });

  it("安装后旧任务入口没有 Core grant 时不能执行 HR 技能", async () => {
    app.start();
    const submitted = await app.submitTask({
      idempotencyKey: "e2e-hr-1",
      skillId: "longhub.skill.resume-screen",
      input: { requiredKeywords: ["TypeScript", "招聘"], resumeText: "五年 typescript 招聘经验" },
    });
    const task = await waitForTerminal(submitted.taskId);
    expect(task.status).toBe("failed");
  }, 20_000);
  },
);
