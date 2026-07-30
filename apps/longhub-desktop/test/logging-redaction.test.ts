import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenClawCliGatewayTransport } from "../src/openclaw-gateway-client.js";

describe("Desktop 子进程错误脱敏", () => {
  it("OpenClaw CLI 无标签输出也不会泄露 Gateway 与设备 Token", async () => {
    const gatewayToken = "gateway-runtime-secret-0123456789";
    const deviceToken = "dt-runtime-secret-0123456789";
    const transport = new OpenClawCliGatewayTransport({
      nodeExecutable: process.execPath,
      entryScript: fileURLToPath(new URL("./fixtures/failing-openclaw-cli.mjs", import.meta.url)),
      wsUrl: "ws://127.0.0.1:18789",
      token: gatewayToken,
      env: { LONGHUB_MODEL_TOKEN: deviceToken },
    });

    let message = "";
    try {
      await transport.call("config.get", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("OpenClaw RPC config.get 失败");
    expect(message).not.toContain(gatewayToken);
    expect(message).not.toContain(deviceToken);
    expect(message).toContain("[REDACTED]");
  });
});
