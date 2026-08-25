import { describe, expect, it } from "vitest";
import {
  CLIENT_TELEMETRY_SCHEMA,
  ClientTelemetryValidationError,
  clientAgentCountBucket,
  clientStartupBucket,
  parseClientTelemetryBatch,
} from "../src/index.js";

const NOW = new Date("2026-07-30T08:05:00.000Z");

function validBatch(): unknown {
  return {
    schema_version: CLIENT_TELEMETRY_SCHEMA,
    events: [{
      event_type: "client_started",
      occurred_at: "2026-07-30T08:00:00.000Z",
      manager_version: "0.4.0",
      openclaw_version: "2026.7.1-2",
      platform: "win32",
      architecture: "x64",
      fields: { startup_duration: "5_to_15s", active_agent_count: "2_to_5" },
    }],
  };
}

describe("严格匿名客户端遥测契约", () => {
  it("接受固定事件并重建规范对象", () => {
    expect(parseClientTelemetryBatch(validBatch(), NOW)).toEqual(validBatch());
  });

  it.each([
    ["设备标识", { device_id: "dev-secret" }],
    ["用户标识", { user_id: "usr-secret" }],
    ["自由文本", { message: "用户的完整提示词" }],
    ["任意标签", { labels: { url: "https://private.example" } }],
  ])("拒绝事件上的%s字段", (_label, extra) => {
    const batch = validBatch() as { events: Record<string, unknown>[] };
    Object.assign(batch.events[0]!, extra);
    expect(() => parseClientTelemetryBatch(batch, NOW)).toThrow(ClientTelemetryValidationError);
  });

  it("clean launch 拒绝旧 desktop_version 字段，不提供别名", () => {
    const batch = validBatch() as { events: Array<Record<string, unknown>> };
    const { manager_version: _managerVersion, ...withoutManagerVersion } = batch.events[0]!;
    batch.events[0] = {
      ...withoutManagerVersion,
      desktop_version: "0.4.0",
    };
    expect(() => parseClientTelemetryBatch(batch, NOW)).toThrow(ClientTelemetryValidationError);
  });

  it("拒绝 fields 中的未知内容和超出接收窗口的时间", () => {
    const withText = validBatch() as { events: { fields: Record<string, unknown> }[] };
    withText.events[0]!.fields.prompt = "不能上传";
    expect(() => parseClientTelemetryBatch(withText, NOW)).toThrow(ClientTelemetryValidationError);

    const stale = validBatch() as { events: { occurred_at: string }[] };
    stale.events[0]!.occurred_at = "2026-07-29T08:00:00.000Z";
    expect(() => parseClientTelemetryBatch(stale, NOW)).toThrow(ClientTelemetryValidationError);
  });

  it("只输出粗粒度启动耗时与 Agent 数量桶", () => {
    expect([0, 2_000, 5_000, 15_000, 60_000].map(clientStartupBucket)).toEqual([
      "lt_2s", "2_to_5s", "5_to_15s", "15_to_60s", "gte_60s",
    ]);
    expect([0, 1, 2, 6].map(clientAgentCountBucket)).toEqual(["0", "1", "2_to_5", "gte_6"]);
  });

  it("只接受固定的上一进程退出结果", () => {
    const batch = validBatch() as { events: Array<Record<string, unknown>> };
    batch.events[0] = {
      ...batch.events[0],
      event_type: "previous_exit",
      fields: { result: "unclean" },
    };
    expect(parseClientTelemetryBatch(batch, NOW).events[0]).toMatchObject({
      event_type: "previous_exit",
      fields: { result: "unclean" },
    });
    (batch.events[0]!.fields as Record<string, unknown>).reason = "raw crash stack";
    expect(() => parseClientTelemetryBatch(batch, NOW)).toThrow(ClientTelemetryValidationError);
  });
});
