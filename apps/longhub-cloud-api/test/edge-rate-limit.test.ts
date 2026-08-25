import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nginxConfig = readFileSync(
  fileURLToPath(new URL("../../../infrastructure/nginx/longhub-public.conf.template", import.meta.url)),
  "utf8",
);

function locationBlock(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`location = ${escaped} \\{([\\s\\S]*?)\\n  \\}`, "u").exec(nginxConfig);
  if (!match) throw new Error(`缺少 nginx 精确路由 ${path}`);
  return match[1]!;
}

describe("公网 clean-launch 与 Feature Policy 跨实例限流契约", () => {
  it("不再为已下线的授权码激活面配置限流，只保留受保护的策略共享区", () => {
    expect(nginxConfig).not.toContain("longhub_activation_ip");
    expect(nginxConfig).not.toContain("longhub_activation_global");
    expect(nginxConfig).toContain(
      "limit_req_zone $binary_remote_addr zone=longhub_feature_policy_ip:10m rate=240r/m;",
    );
    expect(nginxConfig).toContain(
      "limit_req_zone $server_name zone=longhub_feature_policy_global:1m rate=10000r/m;",
    );
    expect(nginxConfig).not.toMatch(/limit_req_zone\s+\$http_x_forwarded_for/u);
  });

  it("策略端点先经过 IP 与全局桶，再进入任意后端实例", () => {
    const policy = locationBlock("/v1/client/feature-policy");
    expect(policy).toContain("limit_req zone=longhub_feature_policy_ip burst=120 nodelay;");
    expect(policy).toContain("limit_req zone=longhub_feature_policy_global burst=1000 nodelay;");
    expect(policy).toContain("limit_req_status 429;");
    expect(policy).toContain("proxy_pass http://${LONGHUB_CLOUD_API_UPSTREAM};");
  });

  it("429 返回稳定错误码、request_id、retryable 与 Retry-After", () => {
    expect(nginxConfig).toContain("add_header Retry-After 5 always;");
    expect(nginxConfig).not.toContain("ACTIVATION_EDGE_RATE_LIMITED");
    expect(nginxConfig).toContain('"code":"FEATURE_POLICY_EDGE_RATE_LIMITED"');
    expect(nginxConfig).toContain('"request_id":"$request_id","retryable":true');
  });

  it("部署模板不绑定历史公网地址或 Vite 预览端口", () => {
    expect(nginxConfig).not.toContain("154-9-26-158.sslip.io");
    expect(nginxConfig).not.toContain("127.0.0.1:8080");
    expect(nginxConfig).not.toContain("127.0.0.1:8090");
    expect(nginxConfig).toContain("root ${LONGHUB_WEB_ROOT}/portal;");
  });
});
