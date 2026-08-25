import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHrPackSource, HR_PACK_ID } from "@longhub/hr-suite";
import { createCloudApiServer } from "longhub-cloud-api";
import { PackPublisher } from "longhub-console";
import { createEntitlementVerifier } from "../src/bridge-entitlement.js";
import { CloudPackEligibilitySource } from "../src/pack-eligibility.js";
import { activateCloudDevice } from "./helpers/activate-cloud-device.js";

const ADMIN_TOKEN = "bridge-entitlement-admin";
/**
 * Pack entitlements are not part of the clean-launch Manager product. Keep
 * this compatibility test available only for an explicitly requested legacy
 * run so the default suite cannot make the retired surface look supported.
 */
const RUN_LEGACY_SURFACE_TESTS = process.env.LONGHUB_RUN_LEGACY_SURFACE_TESTS === "true";
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let verifier: ReturnType<typeof createEntitlementVerifier>;
let eligibility: CloudPackEligibilitySource;
let entitlementId: string;

beforeAll(async () => {
  if (!RUN_LEGACY_SURFACE_TESTS) return;
  // Historical Pack/entitlement regression only. Clean-launch production keeps
  // the legacy surface disabled in the Cloud API bootstrap.
  api = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    legacySurfaceEnabled: true,
  }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await new PackPublisher(baseUrl, ADMIN_TOKEN).publish(buildHrPackSource("1.0.0"));
  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "0.3.6", device_fingerprint: "bridge-auth-fp" }),
  });
  const device = await registered.json() as { device_id: string; device_token: string };
  await activateCloudDevice(baseUrl, ADMIN_TOKEN, device.device_token);
  const granted = await fetch(`${baseUrl}/v1/admin/entitlements`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ device_id: device.device_id, pack_id: HR_PACK_ID }),
  });
  const entitlement = await granted.json() as { entitlement_id: string };
  entitlementId = entitlement.entitlement_id;
  verifier = createEntitlementVerifier({
    LONGHUB_CLOUD_URL: baseUrl,
    LONGHUB_DEVICE_TOKEN: device.device_token,
    LONGHUB_MANAGER_VERSION: "0.3.6",
  });
  eligibility = new CloudPackEligibilitySource({
    baseUrl,
    deviceToken: device.device_token,
    desktopVersion: "0.3.6",
  });
});

afterAll(() => {
  if (RUN_LEGACY_SURFACE_TESTS) api.close();
});

describe.skipIf(!RUN_LEGACY_SURFACE_TESTS)(
  "历史 Pack Bridge 在线 entitlement 复验（仅显式 LONGHUB_RUN_LEGACY_SURFACE_TESTS=true）",
  () => {
  it("有效授权放行，撤销后同一 Core verifier 立即拒绝", async () => {
    const query = {
      agentId: "longhub-agent-hr",
      packId: HR_PACK_ID,
      packVersion: "1.0.0",
      skillId: "longhub.skill.resume-screen",
    };
    await expect(verifier(query)).resolves.toMatchObject({ active: true });
    await expect(eligibility.eligiblePackIds([{ packId: HR_PACK_ID, version: "1.0.0" }]))
      .resolves.toEqual(new Set([HR_PACK_ID]));
    await expect(verifier({ ...query, packVersion: "9.9.9" })).resolves.toMatchObject({ active: false });

    const revoked = await fetch(`${baseUrl}/v1/admin/entitlements/${entitlementId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(revoked.status).toBe(202);
    await expect(verifier(query)).resolves.toMatchObject({ active: false });
    await expect(eligibility.eligiblePackIds([{ packId: HR_PACK_ID, version: "1.0.0" }]))
      .resolves.toEqual(new Set());
  });
  },
);
