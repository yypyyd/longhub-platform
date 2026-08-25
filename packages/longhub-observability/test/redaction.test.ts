import { describe, expect, it } from "vitest";
import { REDACTED_LOG_VALUE, createConsoleLogger, redactLogText, redactLogValue } from "../src/index.js";

const DEVICE_TOKEN = "dt-device-secret-0123456789";
const GATEWAY_TOKEN = "gateway-secret-0123456789";
const API_KEY = "sk-upstream-secret-0123456789";
const USER_FILE_CONTENT = "候选人身份证号 110101199001011234";

describe("日志脱敏", () => {
  it("递归清除设备、Gateway、API Key 与用户文件内容", () => {
    const safe = redactLogValue({
      device_token: DEVICE_TOKEN,
      nested: {
        gatewayToken: GATEWAY_TOKEN,
        api_key: API_KEY,
        fileContent: USER_FILE_CONTENT,
      },
      safe: { device_id: "dev-123", max_tokens: 4096 },
    });

    expect(safe).toEqual({
      device_token: REDACTED_LOG_VALUE,
      nested: {
        gatewayToken: REDACTED_LOG_VALUE,
        api_key: REDACTED_LOG_VALUE,
        fileContent: REDACTED_LOG_VALUE,
      },
      safe: { device_id: "dev-123", max_tokens: 4096 },
    });
  });

  it("清理异常文本中的 Bearer、URL fragment、已知密钥和授权码", () => {
    const raw = `Bearer ${DEVICE_TOKEN} url=http://127.0.0.1/#token=${GATEWAY_TOKEN} key=${API_KEY} code=LH-AAAA-BBBB-CCCC-DDDD`;
    const safe = redactLogText(raw);
    for (const secret of [DEVICE_TOKEN, GATEWAY_TOKEN, API_KEY, "LH-AAAA-BBBB-CCCC-DDDD"]) {
      expect(safe).not.toContain(secret);
    }
    expect(safe).toContain(REDACTED_LOG_VALUE);
    expect(redactLogText(`unlabelled=${GATEWAY_TOKEN}`, 4096, [GATEWAY_TOKEN])).not.toContain(GATEWAY_TOKEN);
  });

  it("Logger 输出固定元数据且 Error 不携带秘密", () => {
    const lines: string[] = [];
    const logger = createConsoleLogger("manager", {
      sink: (line) => lines.push(line),
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      sensitiveValues: () => [GATEWAY_TOKEN],
    });
    logger.error("gateway.failed", {
      level: "forged",
      event: "forged",
      error: Object.assign(new Error(`authorization: Bearer ${DEVICE_TOKEN}`), { code: "E_GATEWAY" }),
      output: USER_FILE_CONTENT,
      upstream: `unlabelled=${GATEWAY_TOKEN}`,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(DEVICE_TOKEN);
    expect(lines[0]).not.toContain(USER_FILE_CONTENT);
    expect(lines[0]).not.toContain(GATEWAY_TOKEN);
    expect(JSON.parse(lines[0]!)).toEqual({
      error: { name: "Error", message: `authorization: ${REDACTED_LOG_VALUE}`, code: "E_GATEWAY" },
      output: REDACTED_LOG_VALUE,
      upstream: `unlabelled=${REDACTED_LOG_VALUE}`,
      ts: "2026-07-29T00:00:00.000Z",
      level: "error",
      component: "manager",
      event: "gateway.failed",
    });
  });

  it("循环对象和超长数组不会让日志序列化失败", () => {
    const value: { self?: unknown; items: number[] } = { items: Array.from({ length: 60 }, (_, index) => index) };
    value.self = value;
    const safe = redactLogValue(value) as { self: string; items: unknown[] };
    expect(safe.self).toBe("[CIRCULAR]");
    expect(safe.items).toHaveLength(51);
    expect(safe.items.at(-1)).toBe("[TRUNCATED]");
  });
});
