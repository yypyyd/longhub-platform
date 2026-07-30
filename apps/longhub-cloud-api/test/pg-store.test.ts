/**
 * PostgreSQL 存储集成测试：需要真实数据库，设置 LONGHUB_TEST_DATABASE_URL 后运行，
 * 例如：docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=longhub postgres:16-alpine
 *      LONGHUB_TEST_DATABASE_URL=postgres://postgres:longhub@127.0.0.1:55432/postgres
 * 未设置时自动跳过（CI 常规跑内存实现的功能测试即可覆盖行为契约）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackFile, PackManifest } from "@longhub/pack-schema";
import { PgStore } from "../src/pg-store.js";
import type { ModelGatewayConfigRecord } from "../src/store.js";

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
      agentTemplate: { id: "longhub.agent.hr", version: "1.0.0", profilePath: "agent-profile.json" },
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

  it("模型策略：PostgreSQL BIGINT 字段回读为 number，可继续部分更新", async () => {
    const now = new Date().toISOString();
    const config: ModelGatewayConfigRecord = {
      config_id: `pg-model-${Date.now()}`, scope_type: "global", scope_id: "-", enabled: true,
      emergency_disabled: false, base_url: "https://model.example/v1", model_id: "real-model",
      display_name: "默认模型", api_type: "openai-completions", context_window: 128_000, max_tokens: 8_192,
      encrypted_api_key: "encrypted", request_timeout_ms: 300_000, max_retries: 0,
      circuit_breaker_threshold: 5, circuit_breaker_cooldown_ms: 60_000, min_desktop_version: "0.0.0",
      assistant_name: "龙枢助手", assistant_avatar_path: "/assets/longhub-avatar.png", welcome_message: "你好",
      quick_tasks: [], features: { agent_catalog: true, file_upload: true, tool_execution: true },
      device_requests_per_minute: 60, device_daily_tokens: 1_000_000, tenant_monthly_tokens: 100_000_000,
      max_device_concurrency: 100, input_cost_microunits_per_million: 10,
      output_cost_microunits_per_million: 20, cache_cost_microunits_per_million: 5, updated_at: now,
    };
    await store.setModelGatewayConfig(config);
    const loaded = await store.getModelGatewayConfig(config.config_id);
    expect(loaded).toMatchObject({
      device_daily_tokens: 1_000_000, tenant_monthly_tokens: 100_000_000,
      input_cost_microunits_per_million: 10, output_cost_microunits_per_million: 20,
      cache_cost_microunits_per_million: 5,
    });
    for (const value of [
      loaded?.device_daily_tokens, loaded?.tenant_monthly_tokens,
      loaded?.input_cost_microunits_per_million, loaded?.output_cost_microunits_per_million,
      loaded?.cache_cost_microunits_per_million,
    ]) expect(typeof value).toBe("number");
  });

  it("匿名遥测：同维度只累加小时聚合且没有身份字段", async () => {
    const bucket = new Date().toISOString().slice(0, 13) + ":00:00.000Z";
    const record = {
      bucket_start: bucket,
      event_type: "gateway_state" as const,
      desktop_version: "0.4.0",
      openclaw_version: "2026.7.1-2",
      platform: "win32" as const,
      architecture: "x64" as const,
      value: "running",
      agent_count_bucket: "-",
      count: 1,
    };
    await store.incrementClientTelemetry([record, record]);
    const row = (await store.listClientTelemetry()).find((candidate) =>
      candidate.bucket_start === bucket && candidate.event_type === "gateway_state" &&
      candidate.desktop_version === "0.4.0" && candidate.value === "running"
    );
    expect(row?.count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(row)).not.toContain("device_");

    const exitRecord = { ...record, event_type: "previous_exit" as const, value: "unclean" };
    await store.incrementClientTelemetry([exitRecord]);
    expect((await store.listClientTelemetry()).some((candidate) =>
      candidate.bucket_start === bucket && candidate.event_type === "previous_exit" && candidate.value === "unclean"
    )).toBe(true);

    const modelRecord = {
      bucket_start: bucket,
      api_type: "openai-completions" as const,
      outcome: "success" as const,
      latency_bucket: "lt_1s" as const,
      count: 1,
    };
    await store.incrementModelRequestMetrics([modelRecord, modelRecord]);
    const modelRow = (await store.listModelRequestMetrics()).find((candidate) =>
      candidate.bucket_start === bucket && candidate.api_type === "openai-completions" && candidate.outcome === "success"
    );
    expect(modelRow?.count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(modelRow)).not.toMatch(/device|tenant|request|response|url/i);
  });
});
