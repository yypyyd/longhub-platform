/**
 * Console 发布闭环测试：PackPublisher 上传→云台签名发布→吊销。
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "longhub-cloud-api";
import { PackPublisher, type PackSource } from "../src/pack-publisher.js";

const ADMIN_TOKEN = "console-admin";
/** Retired Pack publisher regression; excluded from the clean-launch default suite. */
const RUN_LEGACY_SURFACE_TESTS = process.env.LONGHUB_RUN_LEGACY_SURFACE_TESTS === "true";

function buildPackSource(version: string): PackSource {
  const profile = {
    schemaVersion: "longhub/agent-profile/v1",
    id: "longhub.agent.hr",
    version: "1.0.0",
    display: { name: "HR 助理", starterPrompts: [] },
    workspace: { identity: "workspace/IDENTITY.md" },
    capabilities: [
      { id: "longhub.capability.recruitment", skillIds: ["longhub.skill.hr"], permissions: [] },
    ],
    openclaw: { skills: [], tools: { allow: [], deny: [] }, sandbox: "strict" },
    memory: { mode: "isolated" },
    lifecycle: { defaultSessionTitle: "HR 新会话", entitlementExpiryPolicy: "readonly" },
    compatibility: {
      minManagerVersion: "1.0.0",
      openclawVersion: "2026.7.1-2",
      profileMigrationVersion: 1,
    },
  };
  return {
    manifest: {
      schemaVersion: "longhub/v1",
      pack: { id: "longhub.hr-suite", version, minManagerVersion: "1.0.0" },
      agentTemplate: { id: "longhub.agent.hr", version: "1.0.0", profilePath: "agent-profile.json" },
      capabilities: [
        { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
      ],
      runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
      limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
      integrity: { algorithm: "sha256", digest: "placeholder", signatureKeyId: "placeholder" },
    },
    files: {
      "agent-profile.json": JSON.stringify(profile),
      "workspace/IDENTITY.md": "# HR 助理",
      "agent.yaml": "id: hr",
    },
  };
}

let api: ReturnType<typeof createCloudApiServer>;
let publisher: PackPublisher;
const workDir = mkdtempSync(join(tmpdir(), "lh-console-"));

beforeAll(async () => {
  if (!RUN_LEGACY_SURFACE_TESTS) return;
  // PackPublisher is a retained offline/legacy regression fixture.  The
  // clean-launch server disables this surface by default; opt in explicitly
  // here so the test does not turn the historical API back on in production.
  api = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    legacySurfaceEnabled: true,
  }).listen(0);
  await once(api, "listening");
  publisher = new PackPublisher(`http://127.0.0.1:${(api.address() as AddressInfo).port}`, ADMIN_TOKEN);
});

afterAll(() => {
  if (RUN_LEGACY_SURFACE_TESTS) api.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!RUN_LEGACY_SURFACE_TESTS)(
  "历史 PackPublisher 发布与吊销（仅显式 LONGHUB_RUN_LEGACY_SURFACE_TESTS=true）",
  () => {
  it("上传后由云端签名发布", async () => {
    const result = await publisher.publish(buildPackSource("1.0.0"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.release).toMatchObject({ pack_id: "longhub.hr-suite", version: "1.0.0", status: "active" });
      expect(result.release.signature_key_id?.length).toBeGreaterThan(0);
    }
  });

  it("同版本重发返回 VERSION_EXISTS", async () => {
    const result = await publisher.publish(buildPackSource("1.0.0"));
    expect(result).toMatchObject({ ok: false, code: "VERSION_EXISTS" });
  });

  it("错误管理凭据被拒绝", async () => {
    const bad = new PackPublisher(publisher["baseUrl"], "wrong-token");
    const result = await bad.publish(buildPackSource("1.1.0"));
    expect(result).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });

  it("从 pack.json 文件读取并发布", async () => {
    const packPath = join(workDir, "pack.json");
    writeFileSync(packPath, JSON.stringify(buildPackSource("1.1.0")), "utf-8");
    const result = await publisher.publish(PackPublisher.loadPackSource(packPath));
    expect(result.ok).toBe(true);
  });

  it("吊销已发布版本", async () => {
    const result = await publisher.revoke("longhub.hr-suite", "1.0.0");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.release.status).toBe("revoked");
  });

  it("吊销未知版本返回 RELEASE_NOT_FOUND", async () => {
    const result = await publisher.revoke("longhub.hr-suite", "9.9.9");
    expect(result).toMatchObject({ ok: false, code: "RELEASE_NOT_FOUND" });
  });
  },
);
