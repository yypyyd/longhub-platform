import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCloudSkillAdapterFile,
  verifyCloudSkillAdapterFileDigests,
  verifyCloudSkillAdapterSignature,
  type CloudSkillAdapterManifest,
} from "@longhub/cloud-skill-adapter";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";
import type { CloudSkillAdapterReleaseRecord } from "../src/store.js";

const ADMIN_TOKEN = "adapter-release-admin";
const SKILL_ID = "longhub.skill.adapter-distribution";
const VERSION = "1.0.0";
const OPENCLAW_VERSION = "2026.7.1-2";

function changeFirstChar(value: string, expected: string, replacement: string): string {
  return `${value[0] === expected ? replacement : expected}${value.slice(1)}`;
}

function catalogPolicy(): FeaturePolicyEntry {
  return {
    feature_id: "skill.catalog",
    enabled: true,
    scope: "global",
    audience: "user",
    mode: "default",
    risk_level: "low",
    limits: {},
    data_policy: {
      processing_location: "platform_region",
      retention_days: 30,
      export_allowed: false,
      deletion_allowed: false,
    },
    required_entitlements: [],
    required_permissions: [],
    min_manager_version: "0.1.0",
    emergency_disabled: false,
  };
}

function adapterFixture(): { manifest: CloudSkillAdapterManifest; files: Record<string, string> } {
  const contents = {
    "SKILL.md": "---\nname: adapter-distribution\ndescription: Adapter test declaration\n---\n\nThis file is a thin declaration only. Runtime execution stays in LongHub Cloud.\n",
    "schemas/input.json": JSON.stringify({ type: "object", properties: { text: { type: "string" } }, additionalProperties: false }),
    "schemas/output.json": JSON.stringify({ type: "object", properties: { result: { type: "string" } }, additionalProperties: false }),
  };
  const files = Object.fromEntries(Object.entries(contents).map(([path, content]) => [
    path,
    createCloudSkillAdapterFile(path, content),
  ]));
  const manifest = {
    schema_version: "longhub/cloud-skill-adapter/v1",
    skill_id: SKILL_ID,
    version: VERSION,
    display: { name: "Adapter distribution", description: "Adapter distribution test", category: "test" },
    service: { service_id: "longhub.cloud.adapter-distribution", api_version: "1.0", entry: "local-longhub-bridge" },
    schemas: { input: "schemas/input.json", output: "schemas/output.json" },
    files: Object.values(files),
    subscription: { plan_ids: ["adapter-plan"] },
    permissions: { requested: ["candidate.read"], confirmation_class: "none" },
    compatibility: { manager_min_version: "0.1.0", openclaw_version: OPENCLAW_VERSION },
    integrity: {
      algorithm: "sha256",
      digest: "0".repeat(64),
      signature_key_id: "ignored-by-server",
      signature: "A".repeat(86) + "==",
    },
  } satisfies CloudSkillAdapterManifest;
  return {
    manifest,
    files: Object.fromEntries(Object.entries(contents).map(([path, content]) => [
      path,
      Buffer.from(content, "utf8").toString("base64"),
    ])),
  };
}

describe("Cloud Skill adapter release distribution", () => {
  let store: MemoryStore;
  let api: ReturnType<typeof createCloudApiServer>;
  let baseUrl: string;
  let deviceToken: string;
  let skillManifest: CloudSkillAdapterManifest;
  let skillFiles: Record<string, string>;

  beforeAll(async () => {
    store = new MemoryStore();
    api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store, adminToken: ADMIN_TOKEN }).listen(0);
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const registered = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "windows", app_version: "0.1.0", device_fingerprint: "adapter-release-device" }),
    });
    expect(registered.status).toBe(201);
    const device = await registered.json() as { device_id: string; device_token: string; tenant_id: string };
    deviceToken = device.device_token;

    const user = (await store.createUser({ email: "adapter-release@example.test", password_hash: "hash" })).user;
    await store.bindDevice(device.device_id, user.user_id);
    await store.createCloudSkillPlan({
      plan_id: "adapter-plan",
      name: "Adapter plan",
      skill_ids: [SKILL_ID],
      price_monthly_fen: 1,
      price_yearly_fen: 1,
    });
    const subscription = (await store.createCloudSkillSubscription({
      user_id: user.user_id,
      tenant_id: device.tenant_id,
      plan_id: "adapter-plan",
      period: "monthly",
      starts_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      source_order_id: "adapter-order",
    })).subscription;
    await store.grantCloudSkillEntitlement({
      subscription_id: subscription.subscription_id,
      skill_id: SKILL_ID,
      plan_id: "adapter-plan",
    });
    await store.upsertFeaturePolicy(catalogPolicy());
    ({ manifest: skillManifest, files: skillFiles } = adapterFixture());
  });

  afterAll(async () => {
    api.close();
    await once(api, "close");
  });

  it("publishes and downloads a signed exact-three-file adapter without activation", async () => {
    const published = await fetch(`${baseUrl}/v1/admin/cloud-skill-adapters`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ manifest: skillManifest, files: skillFiles }),
    });
    expect(published.status).toBe(201);
    const summary = await published.json() as { digest: string; signature_key_id: string };
    expect(summary.digest).toMatch(/^[a-f0-9]{64}$/);

    const catalog = await fetch(`${baseUrl}/v1/catalog/skills?openclaw_version=${OPENCLAW_VERSION}`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as {
      skills: Array<{ skill_id: string; adapter_available?: boolean; publisher?: unknown }>
    }).skills)
      .toEqual([expect.objectContaining({
        skill_id: SKILL_ID,
        adapter_available: true,
        publisher: { namespace: "longhub", displayName: "龙枢官方" },
      })]);

    const download = await fetch(
      `${baseUrl}/v1/skills/${SKILL_ID}/adapter?openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    const body = await download.json() as {
      adapter: { manifest: CloudSkillAdapterManifest; files: Record<string, string> };
      digest: string;
      signature_key_id: string;
    };
    const key = await (await fetch(`${baseUrl}/v1/skills/adapters/signing-key`)).json() as { public_key_pem: string };
    expect(verifyCloudSkillAdapterSignature(body.adapter.manifest, key.public_key_pem)).toBe(true);
    expect(verifyCloudSkillAdapterFileDigests(
      body.adapter.manifest,
      new Map(Object.entries(body.adapter.files).map(([path, encoded]) => [path, Buffer.from(encoded, "base64")])),
    )).toBe(true);
    expect(body.digest).toBe(body.adapter.manifest.integrity.digest);
    expect(body.signature_key_id).toBe(body.adapter.manifest.integrity.signature_key_id);
  });

  it("maps adapter release storage failures to a stable retryable error", async () => {
    const original = store.listCloudSkillAdapterReleases.bind(store);
    store.listCloudSkillAdapterReleases = async () => {
      throw new Error("simulated adapter release storage outage");
    };
    try {
      const response = await fetch(
        `${baseUrl}/v1/skills/${SKILL_ID}/adapter?openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
        { headers: { authorization: `Bearer ${deviceToken}` } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "SKILL_DISTRIBUTION_UNAVAILABLE",
        retryable: true,
      });
    } finally {
      store.listCloudSkillAdapterReleases = original;
    }
  });

  it.each([
    [
      "top-level digest",
      (release: CloudSkillAdapterReleaseRecord): CloudSkillAdapterReleaseRecord => ({
        ...release,
        digest: changeFirstChar(release.digest, "0", "1"),
      }),
    ],
    [
      "top-level signature key",
      (release: CloudSkillAdapterReleaseRecord): CloudSkillAdapterReleaseRecord => ({
        ...release,
        signature_key_id: `${release.signature_key_id}-tampered`,
      }),
    ],
    [
      "manifest digest",
      (release: CloudSkillAdapterReleaseRecord): CloudSkillAdapterReleaseRecord => ({
        ...release,
        manifest: {
          ...release.manifest,
          integrity: {
            ...release.manifest.integrity,
            digest: changeFirstChar(release.manifest.integrity.digest, "0", "1"),
          },
        },
      }),
    ],
    [
      "manifest signature",
      (release: CloudSkillAdapterReleaseRecord): CloudSkillAdapterReleaseRecord => ({
        ...release,
        manifest: {
          ...release.manifest,
          integrity: {
            ...release.manifest.integrity,
            signature: changeFirstChar(release.manifest.integrity.signature, "A", "B"),
          },
        },
      }),
    ],
    [
      "encoded file",
      (release: CloudSkillAdapterReleaseRecord): CloudSkillAdapterReleaseRecord => {
        const bytes = Buffer.from(release.files["SKILL.md"]!, "base64");
        bytes[0] = bytes[0]! ^ 1;
        return {
          ...release,
          files: { ...release.files, "SKILL.md": bytes.toString("base64") },
        };
      },
    ],
  ])("fails closed when stored adapter %s is inconsistent", async (_label, mutate) => {
    const original = store.listCloudSkillAdapterReleases.bind(store);
    store.listCloudSkillAdapterReleases = async (skillId?: string) =>
      (await original(skillId)).map((release) => mutate(release));
    try {
      const response = await fetch(
        `${baseUrl}/v1/skills/${SKILL_ID}/adapter?openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
        { headers: { authorization: `Bearer ${deviceToken}` } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "SKILL_DISTRIBUTION_UNAVAILABLE",
        retryable: true,
      });
    } finally {
      store.listCloudSkillAdapterReleases = original;
    }
  });

  it("keeps revoked versions unavailable and does not let the legacy Pack gate decide access", async () => {
    const revoked = await fetch(`${baseUrl}/v1/admin/cloud-skill-adapters/${SKILL_ID}/${VERSION}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(revoked.status).toBe(202);
    const blocked = await fetch(
      `${baseUrl}/v1/skills/${SKILL_ID}/adapter?version=${VERSION}&openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(blocked.status).toBe(410);
  });
});
