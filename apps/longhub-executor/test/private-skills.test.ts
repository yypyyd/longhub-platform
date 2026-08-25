import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { productionExecutorBootstrapConfig } from "../src/main.js";
import {
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_REQUEST_SCHEMA,
  computeExecutorInputDigest,
  createExecutorServer,
  issueExecutorCredential,
  type ExecutorCredentialKey,
} from "../src/server.js";
import {
  PRIVATE_CLOUD_SKILL_IDS,
  PRIVATE_CLOUD_SKILL_REGISTRY,
} from "../src/private-skills/registry.js";

const credentialKey: ExecutorCredentialKey = {
  keyId: "private-registry-test",
  secret: Buffer.alloc(32, 0x51),
};
const servers: ReturnType<typeof createExecutorServer>[] = [];
let requestSequence = 0;

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(): Promise<string> {
  const server = createExecutorServer({
    credentialKey,
    skills: PRIVATE_CLOUD_SKILL_REGISTRY,
  }).listen(0);
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function execute(
  baseUrl: string,
  skillId: string,
  input: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const taskId = "private-registry-task";
  const tenantId = "tenant-a";
  requestSequence += 1;
  const idempotencyKey = `idem-${requestSequence}`;
  const inputDigest = computeExecutorInputDigest(input);
  const credential = issueExecutorCredential(
    { taskId, tenantId, skillId, idempotencyKey, input },
    { key: credentialKey },
  );
  const response = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [EXECUTOR_CREDENTIAL_HEADER]: credential,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      schema_version: EXECUTOR_REQUEST_SCHEMA,
      task_id: taskId,
      tenant_id: tenantId,
      skill_id: skillId,
      idempotency_key: idempotencyKey,
      input_digest: inputDigest,
      input,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("private Cloud Skill registry", () => {
  it("is non-empty, immutable and fixed at build time", () => {
    expect(PRIVATE_CLOUD_SKILL_IDS).toEqual(["longhub.skill.salary-band"]);
    expect([...PRIVATE_CLOUD_SKILL_REGISTRY.keys()]).toEqual(PRIVATE_CLOUD_SKILL_IDS);
    expect(PRIVATE_CLOUD_SKILL_REGISTRY.size).toBeGreaterThan(0);
    expect((PRIVATE_CLOUD_SKILL_REGISTRY as unknown as { set?: unknown }).set).toBeUndefined();
    expect(Object.isFrozen(PRIVATE_CLOUD_SKILL_REGISTRY)).toBe(true);
  });

  it("is wired into the production main entrypoint", () => {
    const config = productionExecutorBootstrapConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.skills).toBe(PRIVATE_CLOUD_SKILL_REGISTRY);
    expect(config.skills.size).toBeGreaterThan(0);
  });

  it("fails closed for a signed request naming an unknown Skill", async () => {
    const baseUrl = await start();
    const result = await execute(baseUrl, "longhub.skill.not-deployed", { level: 3 });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("SKILL_NOT_FOUND");
    expect(JSON.stringify(result.body)).not.toContain("not-deployed");
  });

  it("executes the allowlisted Skill for strictly valid input", async () => {
    const baseUrl = await start();
    const result = await execute(baseUrl, "longhub.skill.salary-band", { level: 3 });
    expect(result.status).toBe(200);
    expect(result.body.output).toEqual({
      level: 3,
      min: 20_000,
      max: 32_000,
      currency: "CNY",
    });
  });

  it("rejects extra fields without leaking input, credentials or a stack", async () => {
    const baseUrl = await start();
    const sensitiveMarkers = [
      "PRIVATE SYSTEM PROMPT",
      "postgres://private-host/secret",
      "lhx1.private-credential",
      "salary-band.ts",
    ];
    const result = await execute(baseUrl, "longhub.skill.salary-band", {
      level: 3,
      prompt: sensitiveMarkers[0],
      database_url: sensitiveMarkers[1],
      credential: sensitiveMarkers[2],
      implementation: sensitiveMarkers[3],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe("SKILL_INPUT_INVALID");
    const response = JSON.stringify(result.body);
    for (const marker of sensitiveMarkers) expect(response).not.toContain(marker);
    expect(response.toLowerCase()).not.toContain("stack");
  });
});
