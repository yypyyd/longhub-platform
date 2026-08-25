import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { beginModelUsage } from "../src/model-usage.js";
import type { DeviceRecord, ModelGatewayConfigRecord } from "../src/store.js";

class BlockingUsageStore extends MemoryStore {
  private announceUsageRead!: () => void;
  private releaseUsageRead?: () => void;
  private blockUsageRead = true;
  readonly usageReadStarted = new Promise<void>((resolve) => { this.announceUsageRead = resolve; });

  release(): void {
    this.releaseUsageRead?.();
  }

  override async listModelUsage() {
    if (this.blockUsageRead) {
      this.blockUsageRead = false;
      this.announceUsageRead();
      await new Promise<void>((resolve) => { this.releaseUsageRead = resolve; });
    }
    return super.listModelUsage();
  }
}

function device(id: string): DeviceRecord {
  return { device_id: id, tenant_id: "tenant-a", status: "active", platform: "windows", app_version: "0.5.0", device_fingerprint: id, device_token: `token-${id}`, created_at: "2026-07-30T00:00:00.000Z" };
}

function config(patch: Partial<ModelGatewayConfigRecord> = {}): ModelGatewayConfigRecord {
  return {
    config_id: "default", scope_type: "global", scope_id: "-", enabled: true, emergency_disabled: false,
    base_url: "https://model.example/v1", model_id: "real", display_name: "默认", api_type: "openai-completions",
    context_window: 128_000, max_tokens: 8_192, input_capabilities: ["text"], encrypted_api_key: "encrypted", request_timeout_ms: 30_000,
    max_retries: 0, circuit_breaker_threshold: 5, circuit_breaker_cooldown_ms: 60_000,
    min_manager_version: "0.0.0", assistant_name: "龙枢助手", assistant_avatar_path: "/assets/longhub-avatar.png",
    welcome_message: "你好", quick_tasks: [], features: { agent_catalog: true, file_upload: true, tool_execution: true },
    device_requests_per_minute: 60, device_daily_tokens: 1_000_000, tenant_monthly_tokens: 100_000_000,
    max_device_concurrency: 2, input_cost_microunits_per_million: 10, output_cost_microunits_per_million: 20,
    cache_cost_microunits_per_million: 5, updated_at: "2026-07-30T00:00:00.000Z", ...patch,
  };
}

describe("模型额度、并发与用量计量", () => {
  it("存储读取等待被中止后立即释放 admission lock，且迟到结果不登记额度", async () => {
    const store = new BlockingUsageStore();
    const current = device("quota-abort");
    const policy = config({ device_requests_per_minute: 1, max_device_concurrency: 1 });
    const controller = new AbortController();
    const aborted = beginModelUsage(store, current, policy, new Date(), controller.signal);
    await store.usageReadStarted;
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const next = await beginModelUsage(store, current, policy);
    next.release();
    store.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await store.listModelUsage()).toEqual([]);
  });

  it("并发准入原子执行，不能同时越过设备并发上限", async () => {
    const store = new MemoryStore();
    const current = device("quota-concurrency-race");
    const policy = config({ device_requests_per_minute: 60, max_device_concurrency: 1 });
    const attempts = await Promise.allSettled([
      beginModelUsage(store, current, policy),
      beginModelUsage(store, current, policy),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "MODEL_CONCURRENCY_LIMITED" } });
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") attempt.value.release();
    }
  });

  it("已准入请求收到 abort 时同步释放并发 lease", async () => {
    const store = new MemoryStore();
    const current = device("quota-admitted-abort");
    const policy = config({ device_requests_per_minute: 60, max_device_concurrency: 1 });
    const controller = new AbortController();
    const lease = await beginModelUsage(store, current, policy, new Date(), controller.signal);

    controller.abort();

    const next = await beginModelUsage(store, current, policy);
    next.release();
    lease.release();
  });

  it("并发准入原子执行，不能同时越过每分钟请求上限", async () => {
    const store = new MemoryStore();
    const current = device("quota-rate-race");
    const policy = config({ device_requests_per_minute: 1, max_device_concurrency: 2 });
    const attempts = await Promise.allSettled([
      beginModelUsage(store, current, policy),
      beginModelUsage(store, current, policy),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "MODEL_RATE_LIMITED" } });
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") attempt.value.release();
    }
  });

  it("并发超限关闭失败，完成后累计日/月 Token 与成本", async () => {
    const store = new MemoryStore();
    const current = device("quota-concurrency");
    const policy = config({ max_device_concurrency: 1 });
    const lease = await beginModelUsage(store, current, policy, new Date("2026-07-30T10:00:00.000Z"));
    await expect(beginModelUsage(store, current, policy, new Date("2026-07-30T10:00:01.000Z"))).rejects.toMatchObject({ code: "MODEL_CONCURRENCY_LIMITED" });
    await lease.complete({ success: true, inputBytes: 400, outputBytes: 800 });
    const rows = await store.listModelUsage();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ request_count: 1, input_tokens: 100, output_tokens: 200, estimated_tokens: 300 });
  });

  it("执行每分钟速率与持久日额度", async () => {
    const store = new MemoryStore();
    const current = device("quota-rate");
    const now = new Date("2026-07-30T10:00:00.000Z");
    const ratePolicy = config({ device_requests_per_minute: 1 });
    const lease = await beginModelUsage(store, current, ratePolicy, now);
    lease.release();
    await expect(beginModelUsage(store, current, ratePolicy, now)).rejects.toMatchObject({ code: "MODEL_RATE_LIMITED" });

    const exhausted = device("quota-daily");
    await store.incrementModelUsage([{ period_start: "2026-07-30", period: "day", tenant_id: exhausted.tenant_id, device_id: exhausted.device_id,
      config_id: "default", request_count: 1, success_count: 1, error_count: 0, input_tokens: 800, output_tokens: 200,
      cache_tokens: 0, estimated_tokens: 0, cost_microunits: 0 }]);
    await expect(beginModelUsage(store, exhausted, config({ device_daily_tokens: 1_000 }), now)).rejects.toMatchObject({ code: "MODEL_DAILY_QUOTA_EXCEEDED" });
  });
});
