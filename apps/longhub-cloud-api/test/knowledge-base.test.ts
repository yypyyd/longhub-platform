import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { MemoryStore } from "../src/memory-store.js";
import { activateTestDevice } from "./helpers/activate-device.js";

const store = new MemoryStore();
const knowledgeDataKey = Buffer.alloc(32, 7);
let server: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store, adminToken: "admin-kb", knowledgeDataKey }).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registered = await fetch(`${baseUrl}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "windows", app_version: "0.6.0", device_fingerprint: "kb-device" }) });
  token = ((await registered.json()) as { device_token: string }).device_token;
  await activateTestDevice(baseUrl, "admin-kb", token);
});

afterAll(() => server.close());

describe("租户知识库与引用", () => {
  it("管理端写入正文但列表不回传，设备查询只返回本租户引用片段", async () => {
    const created = await fetch(`${baseUrl}/v1/admin/knowledge-documents`, { method: "POST", headers: { authorization: "Bearer admin-kb", "content-type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-default", title: "差旅制度", source_label: "员工手册 2026", content: "差旅报销应在返回后十个工作日内提交，并附有效发票。" }) });
    expect(created.status).toBe(201);
    expect((await store.listKnowledgeDocuments("tenant-default"))[0]?.content).not.toContain("十个工作日");
    const listed = await fetch(`${baseUrl}/v1/admin/knowledge-documents?tenant_id=tenant-default`, { headers: { authorization: "Bearer admin-kb" } });
    expect(JSON.stringify(await listed.json())).not.toContain("十个工作日");
    const queried = await fetch(`${baseUrl}/v1/knowledge/query`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: "差旅 报销" }) });
    expect(await queried.json()).toMatchObject({ citations: [{ title: "差旅制度", source_label: "员工手册 2026" }] });
    const audits = await store.listAudits();
    expect(audits.some((audit) => audit.action === "knowledge.document.create")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("十个工作日");
  });
});
