import { describe, expect, it } from "vitest";
import { buildBillingOutboxOperationalSummary, buildOperationalMetrics } from "../src/admin-routes.js";
import type {
  BillingOutboxRecord,
  ClientTelemetryAggregateRecord,
  FeaturePolicyEmergencyObservationRecord,
  HttpRouteMetricRecord,
  ModelRequestAggregateRecord,
} from "../src/store.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function client(
  event_type: ClientTelemetryAggregateRecord["event_type"],
  value: string,
  count: number,
  bucket_start = "2026-07-30T11:00:00.000Z",
  manager_version = "0.4.0",
): ClientTelemetryAggregateRecord {
  return {
    bucket_start,
    event_type,
    manager_version,
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

function http(
  route_id: HttpRouteMetricRecord["route_id"],
  count: number,
  latency_bucket: HttpRouteMetricRecord["latency_bucket"],
  status_class: HttpRouteMetricRecord["status_class"] = "2xx",
): HttpRouteMetricRecord {
  return { bucket_start: "2026-07-30T11:00:00.000Z", route_id, status_class, latency_bucket, count };
}

function emergency(latency_ms: number): FeaturePolicyEmergencyObservationRecord {
  return {
    policy_id: "fp-" + latency_ms,
    revision: latency_ms + 1,
    feature_id: "agent.catalog",
    policy_updated_at: "2026-07-30T10:59:59.000Z",
    first_enforced_at: "2026-07-30T11:00:00.000Z",
    latency_ms,
  };
}

describe("匿名运行健康看板", () => {
  it("只按投递状态汇总 outbox，不返回载荷或错误详情", () => {
    const row = (patch: Partial<BillingOutboxRecord>): BillingOutboxRecord => ({
      outbox_id: "outbox-id",
      event_type: "billing.payment.settled",
      aggregate_id: "order-id",
      settlement_id: "settlement-id",
      payload: { secret: "must-not-escape" },
      attempts: 0,
      available_at: NOW.toISOString(),
      created_at: NOW.toISOString(),
      ...patch,
    });
    const summary = buildBillingOutboxOperationalSummary([
      row({}),
      row({ available_at: new Date(NOW.getTime() + 1_000).toISOString() }),
      row({ locked_until: new Date(NOW.getTime() + 1_000).toISOString() }),
      row({ published_at: NOW.toISOString() }),
      row({ dead_lettered_at: NOW.toISOString(), last_error: "PUBLISH_FAILED" }),
    ], NOW);
    expect(summary).toEqual({ pending: 1, retry_waiting: 1, in_flight: 1, published: 1, dead_lettered: 1 });
    expect(summary).not.toHaveProperty("payload");
    expect(JSON.stringify(summary)).not.toContain("PUBLISH_FAILED");
  });

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
    expect(result.manager_versions).toEqual([{ version: "0.4.0", count: 4 }, { version: "0.3.7", count: 2 }]);
    expect(result.top_product_errors).toEqual([{ code: "LH-GW-004", count: 3 }]);
    expect(JSON.stringify(result)).not.toMatch(/device|tenant|session|prompt|url/i);
  });

  it("没有样本时返回 null 比率而不是误报 0%", () => {
    expect(buildOperationalMetrics([], [], NOW)).toMatchObject({
      crash_rate: null,
      model_success_rate: null,
      update_success_rate: null,
      emergency_disable: { samples: 0, p95_ms: null, within_5s_rate: null },
      service_slo: {
        cloud_api_monthly_availability: { value: null, status: "no_data", source: "external_probe" },
        feature_policy_p95: { value: null, status: "no_data" },
      },
    });
  });

  it("计算固定路由 P95/5xx 和紧急停用 SLO，不把溢出桶误报为达标", () => {
    const metrics = buildOperationalMetrics([], [], NOW, [
      http("client_feature_policy", 95, "200_to_300ms"),
      http("client_feature_policy", 1, "gte_5s", "5xx"),
      http("client_runtime_config", 100, "lt_100ms"),
      http("skill_catalog", 96, "500_to_800ms"),
      http("skill_download", 4, "800ms_to_1s"),
    ], [emergency(100), emergency(4_000), emergency(8_000)]);
    expect(metrics.http_routes.find((row) => row.route_id === "client_feature_policy")).toMatchObject({
      requests: 96,
      five_xx: 1,
      five_xx_rate: 1 / 96,
      p95_latency_bucket: "200_to_300ms",
      p95_latency_upper_bound_ms: 300,
    });
    expect(metrics.service_slo).toMatchObject({
      feature_policy_p95: { value: 300, status: "pass" },
      feature_policy_5xx_rate: { status: "fail" },
      runtime_config_5xx_rate: { value: 0, status: "pass" },
      skill_surface_p95: { value: 800, status: "pass" },
      emergency_disable_p95: { value: 8_000, status: "fail" },
    });
    expect(metrics.emergency_disable).toMatchObject({
      samples: 3,
      p95_ms: 8_000,
      max_ms: 8_000,
      within_5s_rate: 2 / 3,
    });
  });
});
