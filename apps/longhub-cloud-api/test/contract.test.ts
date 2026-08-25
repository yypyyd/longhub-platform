/**
 * 端云契约测试：以 contracts/openapi/longhub-cloud-v1.yaml 为准，
 * 校验任务模块实现与冻结契约一致（路径、幂等/断线恢复参数、状态码、统一错误结构）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutorServer, type CloudSkill } from "longhub-executor";
import { createCloudApiServer } from "../src/server.js";

const spec = readFileSync(
  fileURLToPath(new URL("../../../contracts/openapi/longhub-cloud-v1.yaml", import.meta.url)),
  "utf-8",
);

let executor: ReturnType<typeof createExecutorServer>;
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceToken: string;

// This fixture exercises the current Cloud Skill task envelope.  It uses the
// explicit development executor bypass so the contract test does not need to
// manufacture a retired activation code or Pack entitlement.
const DEVELOPMENT_TASK_FIXTURE = true;
const delayedContractSkill: CloudSkill = async () => {
  // Keep the task in running long enough for the cancel contract assertion;
  // the production Executor owns the actual timeout/cancellation semantics.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  return { ok: true };
};

beforeAll(async () => {
  executor = createExecutorServer({
    skills: new Map([["longhub.skill.salary-band", delayedContractSkill]]),
  }).listen(0);
  await once(executor, "listening");
  api = createCloudApiServer({
    executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
    allowDevelopmentTasks: DEVELOPMENT_TASK_FIXTURE,
    legacySurfaceEnabled: false,
  }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "openclaw-plugin-windows",
      app_version: "1.0.0",
      device_fingerprint: "fp-contract-test",
    }),
  });
  deviceToken = ((await registered.json()) as { device_token: string }).device_token;
});

afterAll(() => {
  api.close();
  executor.close();
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${deviceToken}`,
    "x-longhub-agent-id": "agent-contract",
    ...extra,
  };
}

describe("OpenAPI V1 契约文档", () => {
  it("冻结的任务模块路径全部存在", () => {
    for (const path of ["/tasks:", "/tasks/{taskId}:", "/tasks/{taskId}/cancel:", "/tasks/{taskId}/events:"]) {
      expect(spec).toContain(`  ${path}`);
    }
  });

  it("Identity 与 Entitlement 路径存在", () => {
    for (const path of ["/devices/register:", "/entitlements:"]) {
      expect(spec).toContain(`  ${path}`);
    }
  });

  it("Release/Artifact 分发路径存在", () => {
    for (const path of [
      "/packs/signing-key:",
      "/packs/{packId}/download:",
      "/admin/packs:",
      "/admin/packs/{packId}/{version}/revoke:",
      "/client-releases/latest:",
      "/client-releases/versions/{version}:",
      "/client-releases/signing-key:",
      "/admin/client-releases:",
    ]) {
      expect(spec).toContain(`  ${path}`);
    }
    expect(spec).toContain("SignedClientUpdateMetadata:");
    expect(spec).toContain("ClientUpdateManifest:");
  });

  it("Clean-launch Cloud Skill 订单与支付路径及严格请求 Schema 存在", () => {
    for (const path of ["/cloud-skill-plans:", "/orders:", "/orders/{orderId}/pay:", "/admin/orders:", "/admin/orders/{orderId}/refund:"]) {
      expect(spec).toContain(`  ${path}`);
    }
    expect(spec).toContain("OrderCreateRequest:");
    expect(spec).toContain("OrderPaymentRequest:");
    expect(spec).toContain("const: cloud_skill_plan");
    expect(spec).toContain("PAYMENT_NOT_CONFIGURED");
    expect(spec).not.toContain("RECHARGE_BALANCE_FORBIDDEN");
    expect(spec).not.toContain("RECHARGE_REFUND_FORBIDDEN");
  });

  it("当前 Admin 模型输入契约不再声明旧客户端 UI 字段", () => {
    const start = spec.indexOf("    AdminModelConfigInput:");
    const end = spec.indexOf("    ApiError:", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const inputSchema = spec.slice(start, end);
    for (const field of ["assistant_name", "assistant_avatar_path", "welcome_message", "quick_tasks", "features"]) {
      expect(inputSchema).not.toContain(`${field}:`);
    }
  });

  it("Skill Catalog、专用签名引用与撤销路径存在", () => {
    for (const path of [
      "/catalog/skills:",
      "/catalog/skills/{skillId}:",
      "/skills/signing-key:",
      "/skills/adapters/signing-key:",
      "/skills/{skillId}/reference:",
      "/skills/{skillId}/adapter:",
      "/admin/skills:",
      "/admin/skills/{skillId}/{version}/revoke:",
      "/admin/cloud-skill-adapters:",
      "/admin/cloud-skill-adapters/{skillId}/{version}/revoke:",
    ]) {
      expect(spec).toContain(`  ${path}`);
    }
    expect(spec).toContain("SkillPackage:");
    expect(spec).toContain("const: longhub/skill-package/v1");
    expect(spec).toContain("SkillReference:");
    expect(spec).toContain("additionalProperties: false");
  });

  it("冻结 Cloud Skill adapter、binding 的响应边界和固定文件顺序", () => {
    expect(spec).toContain("CloudSkillAdapterDownload:");
    expect(spec).toContain("required: [adapter, digest, signature_key_id]");
    expect(spec).toContain("prefixItems:");
    expect(spec).toContain("const: schemas/input.json");
    expect(spec).toContain("CloudSkillAdapterPublishManifest:");
    expect(spec).toContain("CloudAgentSkillBindingEnvelope:");
    expect(spec).toContain("/cloud-skill/bindings/{bindingId}:");
    expect(spec).toContain("TaskAgentIdValue:");
    expect(spec).not.toContain("#/components/schemas/TaskAgentId}\n");
  });

  it("匿名客户端遥测路径与严格契约存在", () => {
    expect(spec).toContain("  /client/telemetry:");
    expect(spec).toContain("ClientTelemetryBatch:");
    expect(spec).toContain("additionalProperties: false");
    expect(spec).toContain("const: longhub/client-telemetry/v1");
  });

  it("Feature Policy 使用独立端点和严格 V2 契约", () => {
    expect(spec).toContain("  /client/feature-policy:");
    expect(spec).toContain("  /admin/feature-policies:");
    expect(spec).toContain("FeaturePolicyDocument:");
    expect(spec).toContain("const: longhub/feature-policy/v2");
    expect(spec).toContain("required_entitlements:");
    expect(spec).toContain("required_permissions:");
  });

  it("声明幂等与断线恢复参数", () => {
    expect(spec).toContain("Idempotency-Key");
    expect(spec).toContain("Last-Event-ID");
  });

  it("统一错误结构 ApiError 必填字段冻结", () => {
    expect(spec).toContain("required: [code, message, request_id, retryable]");
  });
});

describe("任务模块实现与契约一致", () => {
  it("createTask：新建返回 201，同幂等键重放返回 200 且为同一任务", async () => {
    const post = (key: string) =>
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: `contract-${key}`,
          kind: "skill.execute",
          skill_id: "longhub.skill.salary-band",
          skill_version: "1.0.0",
          agent_id: "agent-contract",
          tool_call_id: `tool-${key}`,
          session_key_hash: "0".repeat(64),
          idempotency_key: key,
          input: { level: 3 },
        }),
      });
    const created = await post("contract-key-1");
    expect(created.status).toBe(201);
    const first = (await created.json()) as { task_id: string };

    const replayed = await post("contract-key-1");
    expect(replayed.status).toBe(200);
    expect(((await replayed.json()) as { task_id: string }).task_id).toBe(first.task_id);
  });

  it("错误响应符合 ApiError：code/message/request_id/retryable 必填", async () => {
    const cases = [
      // 缺 Idempotency-Key → 4XX
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ kind: "skill.execute", input: { skillId: "x" } }),
      }),
      // 未知任务 → 404
      fetch(`${baseUrl}/v1/tasks/ct-none`, { headers: authHeaders() }),
      // 未知路由 → 404
      fetch(`${baseUrl}/v1/unknown`, { headers: authHeaders() }),
      // 缺设备凭据 → 401
      fetch(`${baseUrl}/v1/entitlements`),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.code).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(typeof body.request_id).toBe("string");
      expect(typeof body.retryable).toBe("boolean");
    }
  });

  it("cancelTask 返回契约状态码 202；事件流为 text/event-stream", async () => {
    const created = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", "idempotency-key": "contract-key-2" }),
      body: JSON.stringify({
        schema_version: "longhub/cloud-skill-call/v1",
        request_id: "contract-cancel",
        kind: "skill.execute",
        skill_id: "longhub.skill.salary-band",
        skill_version: "1.0.0",
        agent_id: "agent-contract",
        tool_call_id: "tool-contract-cancel",
        session_key_hash: "0".repeat(64),
        idempotency_key: "contract-key-2",
        input: { level: 3 },
      }),
    });
    const { task_id } = (await created.json()) as { task_id: string };

    const cancelled = await fetch(`${baseUrl}/v1/tasks/${task_id}/cancel`, {
      method: "POST",
      headers: authHeaders({ "x-longhub-agent-id": "agent-contract" }),
    });
    expect(cancelled.status).toBe(202);

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/v1/tasks/${task_id}/events`, {
      headers: authHeaders({ "x-longhub-agent-id": "agent-contract" }),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });
});
