import { describe, expect, it } from "vitest";
import { REDACTED_LOG_VALUE } from "@longhub/observability";
import { MemoryStore } from "../src/memory-store.js";

describe("Cloud 审计日志脱敏", () => {
  it("落库前清除设备、Gateway、API Key 与用户文件内容", async () => {
    const store = new MemoryStore();
    const secrets = {
      device: "dt-cloud-secret-0123456789",
      gateway: "gateway-cloud-secret-0123456789",
      apiKey: "sk-cloud-secret-0123456789",
      fileContent: "员工薪资文件原文：张三 100000",
    };

    const record = await store.appendAudit("admin:test", "security.redaction-test", {
      device_token: secrets.device,
      gatewayToken: secrets.gateway,
      nested: { api_key: secrets.apiKey, file_content: secrets.fileContent },
      safe: { device_id: "dev-safe", max_tokens: 4096 },
    });
    const serialized = JSON.stringify(record);

    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    expect(record.detail).toEqual({
      device_token: REDACTED_LOG_VALUE,
      gatewayToken: REDACTED_LOG_VALUE,
      nested: { api_key: REDACTED_LOG_VALUE, file_content: REDACTED_LOG_VALUE },
      safe: { device_id: "dev-safe", max_tokens: 4096 },
    });
  });
});
