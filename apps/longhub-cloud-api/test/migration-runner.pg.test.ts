import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.LONGHUB_TEST_DATABASE_URL;
const describeWithPostgres = adminDatabaseUrl ? describe.sequential : describe.skip;
const execFileAsync = promisify(execFile);
const migrationRunner = fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url));

function databaseUrlFor(databaseName: string): string {
  const url = new URL(adminDatabaseUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/u.test(identifier)) throw new Error("unsafe PostgreSQL test database identifier");
  return `"${identifier}"`;
}

describeWithPostgres("clean-launch migration runner against PostgreSQL 16", () => {
  const databases = new Set<string>();
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
  });

  afterAll(async () => {
    for (const databaseName of databases) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)}`);
    }
    await admin.end();
  });

  async function createDatabase(label: string): Promise<{ databaseName: string; databaseUrl: string }> {
    const suffix = randomBytes(6).toString("hex");
    const databaseName = `longhub_migration_${label}_${process.pid}_${suffix}`;
    await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
    databases.add(databaseName);
    return { databaseName, databaseUrl: databaseUrlFor(databaseName) };
  }

  async function invoke(databaseUrl: string, args: string[] = []): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync(process.execPath, [migrationRunner, ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
    return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  }

  it("covers fresh dry-run, migrate, no-op rerun, and checksum rejection", async () => {
    const { databaseUrl } = await createDatabase("lifecycle");

    const initialDryRun = await invoke(databaseUrl, ["--dry-run"]);
    expect(initialDryRun.dry_run).toBe(true);
    expect(initialDryRun.pending).toEqual([
      expect.objectContaining({ filename: "0001-clean-launch-baseline.sql" }),
    ]);

    const before = new pg.Client({ connectionString: databaseUrl });
    await before.connect();
    const untouched = await before.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    await before.end();
    expect(untouched.rows[0]?.table_name).toBeNull();

    const firstRun = await invoke(databaseUrl);
    expect(firstRun.applied).toEqual(["0001-clean-launch-baseline.sql"]);

    const secondRun = await invoke(databaseUrl);
    expect(secondRun.applied).toEqual([]);

    const finalDryRun = await invoke(databaseUrl, ["--dry-run"]);
    expect(finalDryRun.pending).toEqual([]);

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("UPDATE schema_migrations SET checksum = repeat('0', 64)");
    await client.end();
    await expect(invoke(databaseUrl, ["--dry-run"])).rejects.toThrow(/migration checksum\/name mismatch/u);
  });

  it("rolls back baseline DDL when the migration record cannot be inserted", async () => {
    const { databaseUrl } = await createDatabase("rollback");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      name INTEGER NOT NULL,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.end();

    await expect(invoke(databaseUrl)).rejects.toThrow(/invalid input syntax for type integer/u);

    const verification = new pg.Client({ connectionString: databaseUrl });
    await verification.connect();
    const rolledBack = await verification.query("SELECT to_regclass('public.account_user') AS table_name");
    const migrationRows = await verification.query("SELECT count(*)::int AS count FROM schema_migrations");
    await verification.end();
    expect(rolledBack.rows[0]?.table_name).toBeNull();
    expect(migrationRows.rows[0]?.count).toBe(0);
  });
});
