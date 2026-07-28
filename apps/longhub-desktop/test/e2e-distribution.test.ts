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

const ADMIN_TOKEN = "e2e-admin";
const workDir = mkdtempSync(join(tmpdir(), "lh-e2e-"));
const corePath = fileURLToPath(new URL("../dist/core-process.js", import.meta.url));

let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let app: DesktopApp;

beforeAll(async () => {
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", adminToken: ADMIN_TOKEN }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  app = new DesktopApp(new CoreClient({ corePath }), new PackInstaller(join(workDir, "packs")), {
    trustedKeys: new Map(),
    desktopVersion: "1.0.0",
  });
});

afterAll(() => {
  app.stop();
  api.close();
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

describe("发布→授权→安装→执行 全链路", () => {
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

  it("安装后本地执行 HR 技能闭环", async () => {
    app.start();
    const submitted = await app.submitTask({
      idempotencyKey: "e2e-hr-1",
      skillId: "longhub.skill.resume-screen",
      input: { requiredKeywords: ["TypeScript", "招聘"], resumeText: "五年 typescript 招聘经验" },
      grantedPermissions: ["connector:hr-api:read"],
    });
    expect("taskId" in submitted).toBe(true);
    const task = await waitForTerminal((submitted as { taskId: string }).taskId);
    expect(task.status).toBe("succeeded");
    expect(task.output).toMatchObject({ score: 100, recommendation: "pass" });
  }, 20_000);
});
