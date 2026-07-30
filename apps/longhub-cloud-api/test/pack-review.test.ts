import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildHrPackSource } from "../../../packages/longhub-hr-suite/src/pack.js";
import { MemoryStore } from "../src/memory-store.js";
import { scanThirdPartyPack } from "../src/pack-review.js";
import { createCloudApiServer } from "../src/server.js";

describe("第三方 Pack 安全扫描", () => {
  it("接受结构有效且没有危险模式的 Pack", () => {
    const pack = { ...buildHrPackSource("1.0.0"), signature: "pending" };
    expect(scanThirdPartyPack(pack)).toEqual([]);
  });

  it("拒绝动态执行、私钥、Shell、明文远程地址和路径穿越", () => {
    const pack = { ...buildHrPackSource("1.0.0"), signature: "pending" };
    pack.files["skills/unsafe.js"] = "eval(input); child_process.exec('cmd.exe'); http://bad.example";
    pack.files["keys.txt"] = "-----BEGIN PRIVATE KEY-----";
    expect(scanThirdPartyPack(pack)).toEqual(expect.arrayContaining(["DYNAMIC_CODE_EXECUTION", "SHELL_EXECUTION", "INSECURE_REMOTE_URL", "PRIVATE_KEY_MATERIAL"]));
  });

  it("通过管理 API 完成提交、人工批准、重签与不可覆盖发布", async () => {
    const store = new MemoryStore();
    const server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store, adminToken: "admin-review" }).listen(0);
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pack = { ...buildHrPackSource("9.9.1"), signature: "pending" };
      const submitted = await fetch(`${baseUrl}/v1/admin/pack-reviews`, {
        method: "POST",
        headers: { authorization: "Bearer admin-review", "content-type": "application/json" },
        body: JSON.stringify({ publisher: "Test Publisher", pack }),
      });
      expect(submitted.status).toBe(201);
      const reviewId = ((await submitted.json()) as { review_id: string }).review_id;

      const approved = await fetch(`${baseUrl}/v1/admin/pack-reviews/${reviewId}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer admin-review", "content-type": "application/json" },
        body: "{}",
      });
      expect(approved.status).toBe(201);
      expect(await approved.json()).toMatchObject({ review_id: reviewId, status: "published", version: "9.9.1" });
      expect((await store.listReleases("longhub.hr-suite"))).toHaveLength(1);

      const unsafePack = { ...buildHrPackSource("9.9.2"), signature: "pending" };
      unsafePack.files["unsafe.js"] = "eval(input); -----BEGIN PRIVATE KEY-----";
      const rejected = await fetch(`${baseUrl}/v1/admin/pack-reviews`, {
        method: "POST",
        headers: { authorization: "Bearer admin-review", "content-type": "application/json" },
        body: JSON.stringify({ publisher: "Unsafe Publisher", pack: unsafePack }),
      });
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ code: "PACK_REVIEW_REJECTED", status: "rejected" });
      const rejectedRecord = (await store.listPackReviews()).find((review) => review.status === "rejected");
      expect(rejectedRecord?.pack.files).toEqual({});
      expect(JSON.stringify(rejectedRecord)).not.toContain("PRIVATE KEY");

      const approvedAgain = await fetch(`${baseUrl}/v1/admin/pack-reviews/${reviewId}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer admin-review", "content-type": "application/json" },
        body: "{}",
      });
      expect(approvedAgain.status).toBe(409);
    } finally {
      server.close();
    }
  });
});
