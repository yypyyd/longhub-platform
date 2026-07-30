import { describe, expect, it } from "vitest";
import { buildOperationalMetrics } from "../src/admin-routes.js";
import type { ClientTelemetryAggregateRecord, ModelRequestAggregateRecord } from "../src/store.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function client(
  event_type: ClientTelemetryAggregateRecord["event_type"],
  value: string,
  count: number,
  bucket_start = "2026-07-30T11:00:00.000Z",
  desktop_version = "0.4.0",
): ClientTelemetryAggregateRecord {
  return {
    bucket_start,
    event_type,
    desktop_version,
    openclaw_version: "2026.7.1-2",
    platform: "win32",
    architecture: "x64",
    value,
    agent_count_bucket: event_type === "client_started" ? "1" : "-",
    count,
  };
}

function model(outcome: ModelRequestAggregateRecord["outcome"], count: number, latency_bucket: ModelRequestAggregateRecord["latency_bucket"]): ModelRequestAggregateRecord {
  return { bucket_start: "2026-07-30T11:00:00.000Z", api_type: "openai-completions", outcome, latency_bucket, count };
}

describe("匿名运行健康看板", () => {
  it("只按近 24 小时聚合比率、版本、延迟桶和固定错误码", () => {
    const result = buildOperationalMetrics([
      client("client_started", "lt_2s", 4),
      client("client_started", "5_to_15s", 2, "2026-07-30T10:00:00.000Z", "0.3.7"),
      client("previous_exit", "clean", 9),
      client("previous_exit", "unclean", 1),
      client("client_update_result", "healthy", 8),
      client("client_update_result", "failed", 1),
      client("client_update_result", "rollback_completed", 1),
      client("product_error", "LH-GW-004", 3),
      client("client_started", "lt_2s", 99, "2026-07-28T11:00:00.000Z"),
    ], [model("success", 8, "lt_1s"), model("upstream_rejected", 2, "3_to_10s")], NOW);

    expect(result).toMatchObject({
      client_starts: 6,
      crash_rate: 0.1,
      model_requests: 10,
      model_success_rate: 0.8,
      update_success_rate: 0.8,
      product_errors: 3,
      model_latency_buckets: { lt_1s: 8, "3_to_10s": 2 },
    });
    expect(result.desktop_versions).toEqual([{ version: "0.4.0", count: 4 }, { version: "0.3.7", count: 2 }]);
    expect(result.top_product_errors).toEqual([{ code: "LH-GW-004", count: 3 }]);
    expect(JSON.stringify(result)).not.toMatch(/device|tenant|session|prompt|url/i);
  });

  it("没有样本时返回 null 比率而不是误报 0%", () => {
    expect(buildOperationalMetrics([], [], NOW)).toMatchObject({ crash_rate: null, model_success_rate: null, update_success_rate: null });
  });
});
