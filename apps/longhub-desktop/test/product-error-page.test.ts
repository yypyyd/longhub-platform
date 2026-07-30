import { describe, expect, it } from "vitest";
import {
  classifyProductError,
  productStatusDefinition,
  productStatusPage,
  type ProductStatusCode,
} from "../src/product-error-page.js";

function decodeDataPage(url: string): string {
  return decodeURIComponent(url.slice(url.indexOf(",") + 1));
}

describe("product error page", () => {
  it.each<[unknown, ProductStatusCode]>([
    [Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }), "CLOUD_UNREACHABLE"],
    [Object.assign(new Error("request failed"), { status: 401 }), "DEVICE_CREDENTIAL_INVALID"],
    [new Error("查询失败 [ACTIVATION_REVOKED]"), "ACTIVATION_REQUIRED"],
    [new Error("后台未配置 longhub.model.default"), "MODEL_NOT_CONFIGURED"],
    [Object.assign(new Error("too many requests"), { statusCode: 429 }), "RATE_LIMITED"],
    [Object.assign(new Error("upstream failed"), { status: 503 }), "SERVICE_UNAVAILABLE"],
    [Object.assign(new Error("opaque"), { code: "STORAGE_QUOTA_EXCEEDED" }), "STORAGE_QUOTA_EXCEEDED"],
    [Object.assign(new Error("write failed"), { code: "ENOSPC" }), "STORAGE_SPACE_LOW"],
  ])("把异常稳定分类为 %s", (error, expected) => {
    expect(classifyProductError(error)).toBe(expected);
  });

  it("无法识别的异常使用调用方指定的安全回退类别", () => {
    expect(classifyProductError(new Error("opaque"), "GATEWAY_START_TIMEOUT"))
      .toBe("GATEWAY_START_TIMEOUT");
  });

  it("保留 Main 明确给出的稳定产品错误码", () => {
    expect(classifyProductError(Object.assign(new Error("internal"), { code: "GATEWAY_CONFIG_ERROR" })))
      .toBe("GATEWAY_CONFIG_ERROR");
  });

  it("页面只包含白名单文案和短错误码，不接收或泄漏原始诊断", () => {
    const secret = "Bearer super-secret-token";
    const localPath = "C:\\Users\\alice\\.openclaw\\openclaw.json";
    const upstreamUrl = "https://provider.example/v1/chat";
    const code = classifyProductError(new Error(`ECONNREFUSED ${secret} ${localPath} ${upstreamUrl}`));
    const html = decodeDataPage(productStatusPage(code));

    expect(html).toContain(productStatusDefinition(code).publicCode);
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain(secret);
    expect(html).not.toContain(localPath);
    expect(html).not.toContain(upstreamUrl);
    expect(html).not.toContain("<script");
    expect(html).toContain('href="longhub-diagnostics://export/"');
    expect(html).toContain("导出诊断信息");
  });

  it("重连页明确自动恢复且不要求用户配置模型", () => {
    const html = decodeDataPage(productStatusPage("GATEWAY_RECONNECTING"));
    expect(html).toContain("自动回到聊天界面");
    expect(html).toContain("不需要修改任何模型或连接配置");
  });

  it("存储超限页承诺保护聊天和智能体状态", () => {
    const html = decodeDataPage(productStatusPage("STORAGE_QUOTA_EXCEEDED"));
    expect(html).toContain("没有自动删除");
    expect(html).toContain("LH-ST-001");
  });

  it("磁盘不足页给出固定空间要求", () => {
    const html = decodeDataPage(productStatusPage("STORAGE_SPACE_LOW"));
    expect(html).toContain("256 MiB");
    expect(html).toContain("LH-ST-002");
  });
});
