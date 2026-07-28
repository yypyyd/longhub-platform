/**
 * PostgreSQL 存储集成测试：需要真实数据库，设置 LONGHUB_TEST_DATABASE_URL 后运行，
 * 例如：docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=longhub postgres:16-alpine
 *      LONGHUB_TEST_DATABASE_URL=postgres://postgres:longhub@127.0.0.1:55432/postgres
 * 未设置时自动跳过（CI 常规跑内存实现的功能测试即可覆盖行为契约）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackFile, PackManifest } from "@longhub/pack-schema";
import { PgStore } from "../src/pg-store.js";

const databaseUrl = process.env.LONGHUB_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PgStore 持久化", () => {
  let store: PgStore;

  beforeAll(async () => {
    store = new PgStore(databaseUrl!);
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  it("任务：创建/幂等/状态迁移/事件重放", async () => {
    const key = `pg-key-${Date.now()}`;
    const { task, existed } = await store.createTask(key, "skill.execute", { skillId: "s" });
    expect(existed).toBe(false);
    expect(task.status).toBe("pending");

    const dup = await store.createTask(key, "skill.execute", { skillId: "s" });
    expect(dup.existed).toBe(true);
    expect(dup.task.task_id).toBe(task.task_id);

    await store.transition(task.task_id, "running");
    const done = await store.transition(task.task_id, "succeeded", { output: { ok: 1 } });
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ ok: 1 });

    const events = await store.eventsAfter(task.task_id);
    expect(events.map((e) => e.type)).toEqual(["task.accepted", "task.started", "task.succeeded"]);

    const resumed = await store.eventsAfter(task.task_id, events[0]!.event_id);
    expect(resumed.map((e) => e.type)).toEqual(["task.started", "task.succeeded"]);
  });

  it("设备：注册/指纹幂等/凭据查找", async () => {
    const fingerprint = `fp-pg-${Date.now()}`;
    const { device, existed } = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: fingerprint,
    });
    expect(existed).toBe(false);

    const again = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: fingerprint,
    });
    expect(again.existed).toBe(true);
    expect(again.device.device_id).toBe(device.device_id);

    const found = await store.findDeviceByToken(device.device_token);
    expect(found?.device_id).toBe(device.device_id);
  });

  it("授权：授予/查询/撤销", async () => {
    const { device } = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: `fp-pg-ent-${Date.now()}`,
    });
    const granted = await store.grantEntitlement({
      tenant_id: device.tenant_id,
      device_id: device.device_id,
      pack_id: "longhub.hr-suite",
    });
    expect(granted.status).toBe("active");

    const listed = await store.listEntitlements(device.device_id);
    expect(listed).toHaveLength(1);

    const revoked = await store.revokeEntitlement(granted.entitlement_id);
    expect(revoked?.status).toBe("revoked");
  });

  it("发布：发布/重发幂等/查询/吊销", async () => {
    const version = `9.0.${Date.now() % 100000}`;
    const manifest: PackManifest = {
      schemaVersion: "longhub/v1",
      pack: { id: "longhub.hr-suite", version, minDesktopVersion: "1.0.0" },
      agentTemplate: { id: "longhub.agent.hr", version: "1.0.0" },
      capabilities: [
        { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
      ],
      runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
      limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
      integrity: { algorithm: "sha256", digest: "d", signatureKeyId: "k" },
    };
    const pack: PackFile = { manifest, files: { "agent.yaml": "id: hr" }, signature: "sig" };

    const { release, existed } = await store.publishRelease({ pack, digest: "d", signature_key_id: "k" });
    expect(existed).toBe(false);
    expect(release.status).toBe("active");

    const dup = await store.publishRelease({ pack, digest: "d", signature_key_id: "k" });
    expect(dup.existed).toBe(true);

    const fetched = await store.getRelease("longhub.hr-suite", version);
    expect(fetched?.pack.files).toEqual({ "agent.yaml": "id: hr" });

    const revoked = await store.revokeRelease("longhub.hr-suite", version);
    expect(revoked?.status).toBe("revoked");
  });
});
