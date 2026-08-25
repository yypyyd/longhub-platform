/**
 * PostgreSQL 存储集成测试：需要真实数据库，设置 LONGHUB_TEST_DATABASE_URL 后运行，
 * 例如：docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=longhub postgres:16-alpine
 *      LONGHUB_TEST_DATABASE_URL=postgres://postgres:longhub@127.0.0.1:55432/postgres
 * 未设置时自动跳过（CI 常规跑内存实现的功能测试即可覆盖行为契约）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { computeExecutorInputDigest } from "longhub-executor";
import { hashSessionToken, newToken, sessionExpiry } from "../src/auth.js";
import { PgStore } from "../src/pg-store.js";
import { createCloudTaskAdmissionPlaceholder, type ModelGatewayConfigRecord } from "../src/store.js";
import { computeCloudTaskRequestFingerprint } from "../src/task-fingerprint.js";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";

const databaseUrl = process.env.LONGHUB_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);
const migrationRunner = fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url));

describe.skipIf(!databaseUrl)("PgStore 持久化", () => {
  let store: PgStore;

  beforeAll(async () => {
    await execFileAsync(process.execPath, [migrationRunner], {
      env: { ...process.env, DATABASE_URL: databaseUrl! },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    store = new PgStore(databaseUrl!);
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  it("任务：创建/幂等/状态迁移/事件重放", async () => {
    const key = `pg-key-${Date.now()}`;
    const owner = {
      tenant_id: `tenant-${key}`,
      device_id: `device-${key}`,
      agent_id: `agent-${key}`,
    };
    const input = { text: "pg task" };
    const fingerprint = computeCloudTaskRequestFingerprint({
      schema_version: "longhub/cloud-skill-call/v1",
      request_id: `request-${key}`,
      kind: "skill.execute",
      ...owner,
      skill_id: "longhub.skill.pg-task",
      skill_version: "1.0.0",
      tool_call_id: `call-${key}`,
      session_key_hash: "0".repeat(64),
      idempotency_key: key,
      requested_plan_id: null,
      input_digest: computeExecutorInputDigest(input),
    });
    const { task, existed } = await store.createTask(key, "skill.execute", input, owner, fingerprint);
    expect(existed).toBe(false);
    expect(task.status).toBe("pending");

    const binding = await store.findTaskByIdempotency(key, owner);
    expect(binding).toEqual({ task, request_fingerprint: fingerprint });
    expect(binding?.task).not.toHaveProperty("request_fingerprint");

    const dup = await store.createTask(key, "skill.execute", input, owner, fingerprint);
    expect(dup.existed).toBe(true);
    expect(dup.task.task_id).toBe(task.task_id);

    const reopened = new PgStore(databaseUrl!);
    try {
      expect(await reopened.findTaskByIdempotency(key, owner)).toEqual({
        task,
        request_fingerprint: fingerprint,
      });
    } finally {
      await reopened.close();
    }

    expect((await store.claimPendingTask(task.task_id))?.status).toBe("running");
    expect(await store.claimPendingTask(task.task_id)).toBeUndefined();
    const done = await store.transition(task.task_id, "succeeded", { output: { ok: 1 } });
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ ok: 1 });

    const events = await store.eventsAfter(task.task_id);
    expect(events.map((e) => e.type)).toEqual(["task.accepted", "task.started", "task.succeeded"]);

    const resumed = await store.eventsAfter(task.task_id, events[0]!.event_id);
    expect(resumed.map((e) => e.type)).toEqual(["task.started", "task.succeeded"]);
  });

  it("任务终态 CAS 不会覆盖取消", async () => {
    const key = `pg-cancel-race-${Date.now()}`;
    const owner = {
      tenant_id: `tenant-${key}`,
      device_id: `device-${key}`,
      agent_id: `agent-${key}`,
    };
    const input = { text: "cancel race" };
    const fingerprint = computeCloudTaskRequestFingerprint({
      schema_version: "longhub/cloud-skill-call/v1",
      request_id: `request-${key}`,
      kind: "skill.execute",
      ...owner,
      skill_id: "longhub.skill.pg-cancel-race",
      skill_version: "1.0.0",
      tool_call_id: `call-${key}`,
      session_key_hash: "0".repeat(64),
      idempotency_key: key,
      requested_plan_id: null,
      input_digest: computeExecutorInputDigest(input),
    });
    const { task } = await store.createTask(key, "skill.execute", input, owner, fingerprint);
    expect((await store.claimPendingTask(task.task_id))?.status).toBe("running");
    expect((await store.transitionIfStatus(task.task_id, ["running"], "cancelled"))?.status).toBe("cancelled");
    expect(await store.transitionIfStatus(task.task_id, ["running"], "succeeded", { output: { late: true } })).toBeUndefined();
    expect((await store.getTask(task.task_id))?.status).toBe("cancelled");
    expect((await store.eventsAfter(task.task_id)).map((event) => event.type)).toEqual([
      "task.accepted",
      "task.started",
      "task.cancelled",
    ]);
  });

  it("任务准入：占位输入 CAS、晚到清理与幂等键释放", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = {
      tenant_id: `tenant-admission-${suffix}`,
      device_id: `device-admission-${suffix}`,
      agent_id: `agent-admission-${suffix}`,
    };
    const fingerprint = `v1:${"a".repeat(64)}`;
    const placeholder = createCloudTaskAdmissionPlaceholder(fingerprint, "b".repeat(64));
    const input = { text: "postgres admitted secret" };
    const { task } = await store.createTask(`pg-admit-${suffix}`, "skill.execute", placeholder, owner, fingerprint);
    const malformedAdmitPlaceholder = {
      ...placeholder,
      schema_version: "wrong-schema",
    } as unknown as typeof placeholder;

    expect(await store.admitPendingTaskInput(
      task.task_id,
      malformedAdmitPlaceholder,
      { text: "must not persist" },
    )).toBeUndefined();
    expect((await store.getTask(task.task_id))?.input).toEqual(placeholder);

    const admitted = await Promise.all(Array.from({ length: 8 }, () =>
      store.admitPendingTaskInput(task.task_id, placeholder, input)));
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect((await store.getTask(task.task_id))?.input).toEqual(input);
    expect(await store.discardPendingTask(task.task_id, placeholder)).toBe(false);
    expect((await store.claimPendingTask(task.task_id))?.status).toBe("running");
    expect(await store.discardPendingTask(task.task_id, placeholder)).toBe(false);

    const discardKey = `pg-discard-${suffix}`;
    const discardFingerprint = `v1:${"c".repeat(64)}`;
    const discardPlaceholder = createCloudTaskAdmissionPlaceholder(discardFingerprint, "d".repeat(64));
    const malformedPlaceholder = {
      ...discardPlaceholder,
      schema_version: "wrong-schema",
    } as unknown as typeof discardPlaceholder;
    const discardTask = (await store.createTask(
      discardKey,
      "skill.execute",
      discardPlaceholder,
      owner,
      discardFingerprint,
    )).task;
    expect(await store.discardPendingTask(discardTask.task_id, malformedPlaceholder)).toBe(false);
    const discarded = await Promise.all(Array.from({ length: 8 }, () =>
      store.discardPendingTask(discardTask.task_id, discardPlaceholder)));
    expect(discarded.filter(Boolean)).toHaveLength(1);
    expect(await store.getTask(discardTask.task_id)).toBeUndefined();
    expect(await store.findTaskByIdempotency(discardKey, owner)).toBeUndefined();
    const recreated = await store.createTask(discardKey, "skill.execute", discardPlaceholder, owner, discardFingerprint);
    expect(recreated.existed).toBe(false);
    expect(recreated.task.task_id).not.toBe(discardTask.task_id);
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
    expect(found).not.toHaveProperty("device_token");
    expect((await store.updateDeviceVersion(device.device_id, "1.1.0"))?.app_version).toBe("1.1.0");
    expect((await store.getDevice(device.device_id))?.app_version).toBe("1.1.0");
  });

  it("会话：数据库只保存 bearer 摘要并支持查询与删除", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { user } = await store.createUser({
      email: `pg-session-${suffix}@test.cn`,
      password_hash: "test-hash",
    });
    const token = newToken("us");
    await store.createSession({
      subject_type: "user",
      subject_id: user.user_id,
      token,
      expires_at: sessionExpiry(),
    });

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const persisted = await client.query<{ token_hash: string; subject_id: string }>(
        "SELECT token_hash, subject_id FROM auth_session WHERE subject_id = $1",
        [user.user_id],
      );
      expect(persisted.rows).toEqual([{ token_hash: hashSessionToken(token), subject_id: user.user_id }]);
      expect(JSON.stringify(persisted.rows)).not.toContain(token);
    } finally {
      await client.end();
    }

    expect((await store.getSession(token))?.subject_id).toBe(user.user_id);
    expect(await store.getSession(`${token}-wrong`)).toBeUndefined();
    await store.deleteSession(token);
    expect(await store.getSession(token)).toBeUndefined();
  });

  it("Clean launch：旧 Pack entitlement 授予失败关闭", async () => {
    await expect(store.grantEntitlement({
      tenant_id: "tenant-clean-launch",
      device_id: "device-clean-launch",
      pack_id: "longhub.hr-suite",
    })).rejects.toThrowError(/^CLEAN_LAUNCH_UNSUPPORTED:entitlement\.grant$/u);
  });

  it("Cloud Agent-Skill binding：唯一 owner tuple 原子 upsert/撤销/恢复", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { device } = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: `fp-pg-binding-${suffix}`,
    });
    const { user } = await store.createUser({
      email: `pg-binding-${suffix}@test.cn`,
      password_hash: "test-hash",
    });
    expect(await store.bindDevice(device.device_id, user.user_id)).toBeDefined();
    const request = {
      tenant_id: device.tenant_id,
      device_id: device.device_id,
      user_id: user.user_id,
      agent_id: "agent-pg-binding",
      skill_id: "longhub.skill.pg-binding",
    } as const;
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      store.upsertCloudAgentSkillBinding(request)));
    expect(new Set(results.map((result) => result.binding.binding_id))).toHaveLength(1);
    expect(results.filter((result) => !result.existed)).toHaveLength(1);
    const binding = results[0]!.binding;
    expect(await store.resolveCloudAgentSkillBinding(request)).toMatchObject({
      binding_id: binding.binding_id,
      status: "active",
    });
    expect((await store.revokeCloudAgentSkillBinding(binding.binding_id))?.status).toBe("revoked");
    expect(await store.resolveCloudAgentSkillBinding(request)).toBeUndefined();
    expect((await store.upsertCloudAgentSkillBinding(request)).binding.binding_id).toBe(binding.binding_id);
    expect((await store.listCloudAgentSkillBindings({
      tenant_id: device.tenant_id,
      device_id: device.device_id,
      status: "active",
    }))).toHaveLength(1);
  });

  it("Cloud Skill 计划在已有 entitlement 后可幂等更新相同 Skill 集合", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const skillId = `longhub.skill.pg-plan-noop-${suffix}`;
    const planId = `pg-plan-noop-${suffix}`;
    const { user } = await store.createUser({
      email: `pg-plan-noop-${suffix}@test.cn`,
      password_hash: "test-hash",
    });
    await store.createCloudSkillPlan({
      plan_id: planId,
      name: "PostgreSQL no-op plan update",
      skill_ids: [skillId],
      price_monthly_fen: 1,
      price_yearly_fen: 10,
    });
    const order = await store.createOrder({
      user_id: user.user_id,
      type: "cloud_skill_plan",
      plan_id: planId,
      tenant_id: "tenant-default",
      period: "monthly",
      amount_fen: 1,
    });
    const { subscription } = await store.createCloudSkillSubscription({
      user_id: user.user_id,
      tenant_id: "tenant-default",
      plan_id: planId,
      period: "monthly",
      starts_at: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      source_order_id: order.order_id,
    });
    await store.grantCloudSkillEntitlement({
      subscription_id: subscription.subscription_id,
      skill_id: skillId,
      plan_id: planId,
    });

    await expect(store.updateCloudSkillPlan(planId, {
      name: "PostgreSQL no-op plan update verified",
      skill_ids: [skillId],
    })).resolves.toMatchObject({
      plan_id: planId,
      name: "PostgreSQL no-op plan update verified",
      skill_ids: [skillId],
    });
    expect(await store.listCloudSkillEntitlements({
      user_id: user.user_id,
      plan_id: planId,
    })).toEqual([expect.objectContaining({
      subscription_id: subscription.subscription_id,
      skill_id: skillId,
      status: "active",
    })]);
  });

  it("Clean launch：旧 Pack release 发布失败关闭", async () => {
    await expect(store.publishRelease({
      pack: null as never,
      digest: "retired-pack-digest",
      signature_key_id: "retired-pack-key",
    })).rejects.toThrowError(/^CLEAN_LAUNCH_UNSUPPORTED:pack_release\.publish$/u);
  });

  it("Clean launch：旧 SkillPackage release 发布失败关闭", async () => {
    await expect(store.publishSkillRelease({
      package: null as never,
      digest: "retired-skill-digest",
      signature_key_id: "retired-skill-key",
    })).rejects.toThrowError(/^CLEAN_LAUNCH_UNSUPPORTED:skill_release\.publish$/u);
  });

  it("模型策略：PostgreSQL BIGINT 字段回读为 number，可继续部分更新", async () => {
    const now = new Date().toISOString();
    const config: ModelGatewayConfigRecord = {
      config_id: `pg-model-${Date.now()}`, scope_type: "global", scope_id: "-", enabled: true,
      emergency_disabled: false, base_url: "https://model.example/v1", model_id: "real-model",
      display_name: "默认模型", api_type: "openai-completions", context_window: 128_000, max_tokens: 8_192,
      input_capabilities: ["text"],
      encrypted_api_key: "encrypted", request_timeout_ms: 300_000, max_retries: 0,
      circuit_breaker_threshold: 5, circuit_breaker_cooldown_ms: 60_000, min_manager_version: "0.0.0",
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

  it("模型用量：阻塞读取由服务端超时取消且连接池仍可复用", async () => {
    const locker = new pg.Client({ connectionString: databaseUrl });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE model_usage_aggregate IN ACCESS EXCLUSIVE MODE");

    const startedAt = Date.now();
    let queryError: unknown;
    try {
      await store.listModelUsage();
    } catch (error) {
      queryError = error;
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }

    expect(queryError).toMatchObject({ code: "57014" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expect(store.listModelUsage()).resolves.toEqual(expect.any(Array));
  }, 15_000);

  it("Feature Policy：按目标 upsert、revision 递增且严格回读", async () => {
    const policy: FeaturePolicyEntry = {
      feature_id: "skill.catalog",
      enabled: true,
      scope: "tenant",
      scope_id: "tenant-default",
      audience: "user",
      mode: "tenant_controlled",
      risk_level: "low",
      limits: { count: 20 },
      data_policy: {
        processing_location: "tenant_region",
        retention_days: 30,
        export_allowed: false,
        deletion_allowed: true,
      },
      required_entitlements: [],
      required_permissions: [],
      min_manager_version: "0.5.0",
      emergency_disabled: false,
    };
    const first = await store.upsertFeaturePolicy(policy);
    const second = await store.upsertFeaturePolicy({ ...policy, emergency_disabled: true });
    expect(second.policy_id).toBe(first.policy_id);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.policy.emergency_disabled).toBe(true);
    expect((await store.listFeaturePolicies()).some((record) =>
      record.policy_id === first.policy_id && record.policy.scope_id === "tenant-default"
    )).toBe(true);
  });

  it("匿名遥测：同维度只累加小时聚合且没有身份字段", async () => {
    const bucket = new Date().toISOString().slice(0, 13) + ":00:00.000Z";
    const record = {
      bucket_start: bucket,
      event_type: "gateway_state" as const,
      manager_version: "0.4.0",
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
      candidate.manager_version === "0.4.0" && candidate.value === "running"
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

    const httpRecord = {
      bucket_start: bucket,
      route_id: "client_feature_policy" as const,
      status_class: "2xx" as const,
      latency_bucket: "200_to_300ms" as const,
      count: 1,
    };
    await store.incrementHttpRouteMetrics([httpRecord, httpRecord]);
    const httpRow = (await store.listHttpRouteMetrics()).find((candidate) =>
      candidate.bucket_start === bucket && candidate.route_id === "client_feature_policy"
    );
    expect(httpRow?.count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(httpRow)).not.toMatch(/device|tenant|session|query|url/i);

    const observation = {
      policy_id: `fp-observe-${Date.now()}`,
      revision: 1,
      feature_id: "agent.catalog",
      policy_updated_at: bucket,
      first_enforced_at: new Date(Date.parse(bucket) + 123).toISOString(),
      latency_ms: 123,
    };
    expect(await store.recordFeaturePolicyEmergencyObservation(observation)).toBe(true);
    expect(await store.recordFeaturePolicyEmergencyObservation(observation)).toBe(false);
    expect((await store.listFeaturePolicyEmergencyObservations()).some((candidate) =>
      candidate.policy_id === observation.policy_id && candidate.latency_ms === 123
    )).toBe(true);
  });

  it("provider 结算、退款与 outbox 在多实例下保持幂等和 fencing", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const planId = `pg-provider-${suffix}`;
    const tenantId = `tenant-provider-${suffix}`;
    const user = (await store.createUser({
      email: `pg-provider-${suffix}@test.cn`,
      password_hash: "test-hash",
    })).user;
    await store.createCloudSkillPlan({
      plan_id: planId,
      name: "PostgreSQL Provider Settlement",
      skill_ids: ["longhub.skill.provider-alpha", "longhub.skill.provider-beta"],
      price_monthly_fen: 1_500,
      price_yearly_fen: 15_000,
    });
    const firstOrder = await store.createOrder({
      user_id: user.user_id,
      type: "cloud_skill_plan",
      plan_id: planId,
      tenant_id: tenantId,
      period: "monthly",
      amount_fen: 1_500,
    });
    const secondOrder = await store.createOrder({
      user_id: user.user_id,
      type: "cloud_skill_plan",
      plan_id: planId,
      tenant_id: tenantId,
      period: "monthly",
      amount_fen: 1_500,
    });
    const peer = new PgStore(databaseUrl!);
    await peer.init();
    try {
      const firstPayment = {
        order_id: firstOrder.order_id,
        user_id: user.user_id,
        method: "provider" as const,
        provider_reference: `pay:${suffix}:first`,
        idempotency_key: `payment:${suffix}:first`,
        request_hash: `v1:${"a".repeat(64)}`,
      };
      const [firstPaymentResult, firstPaymentReplay] = await Promise.all([
        store.settleOrderPayment(firstPayment),
        peer.settleOrderPayment(firstPayment),
      ]);
      expect([firstPaymentResult.replayed, firstPaymentReplay.replayed].sort()).toEqual([false, true]);
      expect(firstPaymentResult.settlement.settlement_id).toBe(firstPaymentReplay.settlement.settlement_id);
      await expect(peer.settleOrderPayment({
        ...firstPayment,
        idempotency_key: `payment:${suffix}:conflict`,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      const secondPayment = await store.settleOrderPayment({
        order_id: secondOrder.order_id,
        user_id: user.user_id,
        method: "provider",
        provider_reference: `pay:${suffix}:second`,
        idempotency_key: `payment:${suffix}:second`,
        request_hash: `v1:${"b".repeat(64)}`,
      });
      expect(secondPayment.replayed).toBe(false);

      const subscriptions = await store.listCloudSkillSubscriptions(user.user_id);
      const firstSubscription = subscriptions.find((row) => row.source_order_id === firstOrder.order_id);
      const secondSubscription = subscriptions.find((row) => row.source_order_id === secondOrder.order_id);
      expect(firstSubscription?.status).toBe("active");
      expect(secondSubscription?.status).toBe("active");
      const entitlements = await store.listCloudSkillEntitlements({ user_id: user.user_id, plan_id: planId });
      expect(entitlements.filter((row) => row.subscription_id === firstSubscription?.subscription_id)).toHaveLength(2);
      expect(entitlements.filter((row) => row.subscription_id === secondSubscription?.subscription_id)).toHaveLength(2);

      const summaryNow = new Date(Date.now() + 2_000);
      const owner = {
        tenant_id: tenantId,
        device_id: `device-provider-${suffix}`,
        agent_id: `agent-provider-${suffix}`,
      };
      const summaryTask = (await store.createTask(
        `provider-summary-${suffix}`,
        "skill.execute",
        { text: "anonymous summary" },
        owner,
        `v1:${"e".repeat(64)}`,
      )).task;
      const admitted = await store.reserveCloudSkillExecution({
        task_id: summaryTask.task_id,
        user_id: user.user_id,
        ...owner,
        skill_id: "longhub.skill.provider-alpha",
        plan_id: planId,
        subscription_id: secondSubscription!.subscription_id,
        now: summaryNow.toISOString(),
        lease_ttl_ms: 10_000,
        input_digest: "d".repeat(64),
      });
      expect(admitted.ok).toBe(true);
      await store.transitionIfStatus(summaryTask.task_id, ["pending"], "succeeded");
      await store.releaseCloudSkillExecution({
        task_id: summaryTask.task_id,
        now: new Date(summaryNow.getTime() + 100).toISOString(),
      });
      const operational = await peer.getCloudSkillOperationalSummary(
        new Date(summaryNow.getTime() + 200).toISOString(),
      );
      expect(operational.skills.find((row) => row.plan_id === planId &&
        row.skill_id === "longhub.skill.provider-alpha")).toEqual({
        plan_id: planId,
        skill_id: "longhub.skill.provider-alpha",
        calls: 1,
        active_concurrency: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        active_subscriptions: 2,
        included_calls_per_subscription: 1_000,
      });

      const claimTime = new Date(Date.now() + 1_000);
      const [firstWorkerClaims, secondWorkerClaims] = await Promise.all([
        store.claimBillingOutbox({ limit: 100, lease_ms: 1_000, now: claimTime.toISOString() }),
        peer.claimBillingOutbox({ limit: 100, lease_ms: 1_000, now: claimTime.toISOString() }),
      ]);
      const paymentClaims = [...firstWorkerClaims, ...secondWorkerClaims]
        .filter((row) => row.aggregate_id === firstOrder.order_id || row.aggregate_id === secondOrder.order_id);
      expect(paymentClaims).toHaveLength(2);
      expect(new Set(paymentClaims.map((row) => row.outbox_id)).size).toBe(2);
      const staleClaim = paymentClaims[0]!;
      const completedClaim = paymentClaims[1]!;
      expect(await store.completeBillingOutbox(staleClaim.outbox_id, "bol-wrong-token", claimTime.toISOString())).toBe(false);
      expect(await store.completeBillingOutbox(
        completedClaim.outbox_id,
        completedClaim.lock_token!,
        new Date(claimTime.getTime() + 100).toISOString(),
      )).toBe(true);
      const afterLease = new Date(claimTime.getTime() + 1_001);
      expect(await store.completeBillingOutbox(
        staleClaim.outbox_id,
        staleClaim.lock_token!,
        afterLease.toISOString(),
      )).toBe(false);
      const reclaimed = await peer.claimBillingOutbox({ limit: 10, lease_ms: 1_000, now: afterLease.toISOString() });
      expect(reclaimed.map((row) => row.outbox_id)).toContain(staleClaim.outbox_id);
      const freshClaim = reclaimed.find((row) => row.outbox_id === staleClaim.outbox_id)!;
      expect(freshClaim.lock_token).not.toBe(staleClaim.lock_token);
      expect(await store.completeBillingOutbox(
        staleClaim.outbox_id,
        staleClaim.lock_token!,
        new Date(afterLease.getTime() + 100).toISOString(),
      )).toBe(false);
      expect(await peer.completeBillingOutbox(
        freshClaim.outbox_id,
        freshClaim.lock_token!,
        new Date(afterLease.getTime() + 100).toISOString(),
      )).toBe(true);

      const refundRequest = {
        order_id: firstOrder.order_id,
        actor: "admin:pg-provider-test",
        provider_reference: `refund:${suffix}:first`,
        idempotency_key: `refund:${suffix}:first`,
        request_hash: `v1:${"c".repeat(64)}`,
      };
      const [refundResult, refundReplay] = await Promise.all([
        store.settleOrderRefund(refundRequest),
        peer.settleOrderRefund(refundRequest),
      ]);
      expect([refundResult.replayed, refundReplay.replayed].sort()).toEqual([false, true]);
      expect(refundResult.settlement.settlement_id).toBe(refundReplay.settlement.settlement_id);
      expect((await store.getOrder(firstOrder.order_id))?.status).toBe("refunded");
      expect((await store.getOrder(secondOrder.order_id))?.status).toBe("paid");
      const afterRefund = await store.listCloudSkillEntitlements({ user_id: user.user_id, plan_id: planId });
      expect(afterRefund.filter((row) => row.subscription_id === firstSubscription?.subscription_id)
        .every((row) => row.status === "revoked")).toBe(true);
      expect(afterRefund.filter((row) => row.subscription_id === secondSubscription?.subscription_id)
        .every((row) => row.status === "active")).toBe(true);

      const refundClaimTime = new Date(Date.now() + 5_000);
      const refundClaims = await store.claimBillingOutbox({ limit: 10, lease_ms: 1_000, now: refundClaimTime.toISOString() });
      const refundClaim = refundClaims.find((row) => row.aggregate_id === firstOrder.order_id &&
        row.event_type === "billing.refund.settled")!;
      expect(refundClaim.attempts).toBe(1);
      const retryAt = new Date(refundClaimTime.getTime() + 500);
      expect(await store.failBillingOutbox({
        outbox_id: refundClaim.outbox_id,
        lock_token: refundClaim.lock_token!,
        failed_at: new Date(refundClaimTime.getTime() + 100).toISOString(),
        retry_at: retryAt.toISOString(),
        error_code: "PUBLISH_FAILED",
      })).toBe(true);
      const earlyRetryClaims = await peer.claimBillingOutbox({
        limit: 10,
        lease_ms: 1_000,
        now: new Date(retryAt.getTime() - 1).toISOString(),
      });
      expect(earlyRetryClaims.some((row) => row.outbox_id === refundClaim.outbox_id)).toBe(false);
      const retryClaims = await peer.claimBillingOutbox({ limit: 10, lease_ms: 1_000, now: retryAt.toISOString() });
      const retryClaim = retryClaims.find((row) => row.outbox_id === refundClaim.outbox_id)!;
      expect(retryClaim.attempts).toBe(2);
      const deadLetteredAt = new Date(retryAt.getTime() + 100);
      expect(await peer.failBillingOutbox({
        outbox_id: retryClaim.outbox_id,
        lock_token: retryClaim.lock_token!,
        failed_at: deadLetteredAt.toISOString(),
        retry_at: new Date(retryAt.getTime() + 500).toISOString(),
        error_code: "PUBLISH_FAILED",
        dead_lettered_at: deadLetteredAt.toISOString(),
      })).toBe(true);
      const deadLettered = (await store.listBillingOutbox()).find((row) => row.outbox_id === refundClaim.outbox_id);
      expect(deadLettered).toMatchObject({ attempts: 2, last_error: "PUBLISH_FAILED" });
      expect(deadLettered?.dead_lettered_at).toBe(deadLetteredAt.toISOString());
      const afterDeadLetterClaims = await store.claimBillingOutbox({
        limit: 10,
        lease_ms: 1_000,
        now: new Date(retryAt.getTime() + 10_000).toISOString(),
      });
      expect(afterDeadLetterClaims.some((row) => row.outbox_id === refundClaim.outbox_id)).toBe(false);
    } finally {
      await peer.close();
    }
  }, 20_000);
});
