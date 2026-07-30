import { describe, expect, it, vi } from "vitest";
import { CLIENT_TELEMETRY_SCHEMA, parseClientTelemetryBatch } from "@longhub/observability";
import { ClientTelemetryReporter } from "../src/client-telemetry.js";

function reporter(fetchImpl: typeof fetch, onDrop = vi.fn()): ClientTelemetryReporter {
  return new ClientTelemetryReporter({
    baseUrl: "https://cloud.example",
    deviceToken: "dt-secret-token",
    desktopVersion: "0.4.0",
    openClawVersion: "2026.7.1-2",
    platform: "win32",
    architecture: "x64",
    fetchImpl,
    now: () => new Date("2026-07-30T08:00:00.000Z"),
    flushDelayMs: 60_000,
    onDrop,
  });
}

describe("ClientTelemetryReporter", () => {
  it("请求体不包含凭据或身份，且只发送严格契约", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const client = reporter(fetchImpl);
    client.recordStarted(7_000, 3);
    client.recordGatewayState("running");
    client.recordProductError("LH-GW-004");
    client.recordPreviousExit("unclean");
    await client.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://cloud.example/v1/client/telemetry");
    expect(init?.headers).toMatchObject({ authorization: "Bearer dt-secret-token" });
    const raw = String(init?.body);
    expect(raw).not.toContain("dt-secret-token");
    expect(raw).not.toContain("device_id");
    expect(raw).not.toContain("user_id");
    const parsed = parseClientTelemetryBatch(JSON.parse(raw), new Date("2026-07-30T08:00:00.000Z"));
    expect(parsed.schema_version).toBe(CLIENT_TELEMETRY_SCHEMA);
    expect(parsed.events).toHaveLength(4);
    client.stop();
  });

  it("网络失败只丢弃当前批次，后续上报仍可继续", async () => {
    const onDrop = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = reporter(fetchImpl, onDrop);
    client.recordUpdateResult("failed");
    await expect(client.flush()).resolves.toBeUndefined();
    expect(onDrop).toHaveBeenCalledOnce();

    client.recordUpdateResult("none");
    await expect(client.flush()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    client.stop();
  });
});
