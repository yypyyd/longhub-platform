import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PG_STORE_POOL_LIMITS } from "../src/pg-store.js";

const sourcePath = fileURLToPath(new URL("../src/pg-store.ts", import.meta.url));
const baselinePath = fileURLToPath(new URL("../../../infrastructure/migrations/clean-launch/0001-clean-launch-baseline.sql", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const baseline = readFileSync(baselinePath, "utf8");

describe("PgStore clean-launch schema boundary", () => {
  it("bounds connection, statement, query and lock waits", () => {
    expect(PG_STORE_POOL_LIMITS).toEqual({
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
      lock_timeout: 30_000,
    });
  });

  it("keeps init read-only and migration-owned", () => {
    const initStart = source.indexOf("async init(): Promise<void>");
    const initEnd = source.indexOf("async findTaskByIdempotency(", initStart);
    expect(initStart).toBeGreaterThanOrEqual(0);
    expect(initEnd).toBeGreaterThan(initStart);
    const init = source.slice(initStart, initEnd);
    expect(init).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/iu);
    expect(init).toContain("assertCleanLaunchSchema");
  });

  it("does not issue SQL against retired launch surfaces", () => {
    expect(source).not.toMatch(/\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+(?:activation_code|entitlement|pack_release|skill_release|product|wallet_txn|knowledge_document|pack_review)\b/iu);
    expect(source).not.toMatch(/\bdevice_token\s*=\s*\$1/iu);
    expect(source).toContain("device_token_hash = $1");
    expect(source).toContain("device_token_hash=COALESCE");
  });

  it("defines one pairing table and hashes both pairing/device credentials", () => {
    expect((baseline.match(/CREATE TABLE device_pairing_challenge\s*\(/g) ?? []).length).toBe(1);
    expect(baseline).toContain("device_token_hash TEXT NOT NULL UNIQUE");
    expect(baseline).not.toMatch(/\bdevice_token\s+TEXT\b/iu);
    expect(baseline).toContain("code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^v1:[a-f0-9]{64}$')");
  });

  it("stores only a digest for user and Admin session bearers", () => {
    expect(baseline).toContain("token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$')");
    expect(baseline).not.toMatch(/\btoken\s+TEXT\s+PRIMARY\s+KEY/iu);
    expect(source).toContain("WHERE token_hash = $1");
    expect(source).toContain("hashSessionToken(params.token)");
  });

  it("pins PgStore startup to the exact clean-launch baseline bytes", () => {
    const checksum = createHash("sha256").update(Buffer.from(baseline, "utf8")).digest("hex");
    const pinned = /const CLEAN_LAUNCH_MIGRATION = Object\.freeze\(\{[\s\S]*?checksum: "([a-f0-9]{64})"/u.exec(source);
    expect(pinned?.[1]).toBe(checksum);
  });
});
