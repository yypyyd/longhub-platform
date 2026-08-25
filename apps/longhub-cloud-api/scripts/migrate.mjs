#!/usr/bin/env node
/**
 * Clean-launch-only PostgreSQL migration runner. Historical SQL is never
 * selected through an argument or environment variable.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = resolve(ROOT, "infrastructure", "migrations", "clean-launch");
const FILE_RE = /^(?<version>[0-9]{4})-(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/u;
const LOCK = 7_103_885_271n;
export const PINNED_CLEAN_LAUNCH_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: "0001",
    name: "clean-launch-baseline",
    filename: "0001-clean-launch-baseline.sql",
    checksum: "98bbcc61604444e7c6635ebbb2a9b8ebfd0b85e81f9faf76989ac3144d00be7f",
  }),
]);
const FORBIDDEN = Object.freeze([
  "activation_code", "entitlement", "pack_release", "pack_review", "skill_release",
  "product", "wallet_txn", "knowledge_document",
]);

export const EXPECTED_CLEAN_LAUNCH_TABLES = Object.freeze([
  "schema_migrations",
  "account_user", "auth_session", "admin_account", "audit_log", "device", "device_pairing_challenge",
  "cloud_task", "cloud_task_event", "cloud_skill_adapter_release", "cloud_skill_plan",
  "cloud_skill_plan_skill", "billing_order", "cloud_skill_subscription", "cloud_skill_entitlement",
  "cloud_agent_skill_binding", "cloud_skill_execution_reservation", "model_gateway_config",
  "feature_policy", "client_telemetry_hourly", "model_request_hourly", "http_route_hourly",
  "feature_policy_emergency_observation", "model_usage_aggregate", "manager_release",
  "billing_settlement", "billing_outbox",
]);

// BIGSERIAL creates the first sequence; the second is explicit in the baseline.
export const EXPECTED_CLEAN_LAUNCH_SEQUENCES = Object.freeze([
  "cloud_task_event_event_id_seq",
  "feature_policy_revision_seq",
]);

const SCHEMA_OBJECTS_SQL = `
WITH target_namespace AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1
), objects AS (
  SELECT
    CASE class.relkind
      WHEN 'r' THEN 'table'
      WHEN 'p' THEN 'partitioned_table'
      WHEN 'v' THEN 'view'
      WHEN 'm' THEN 'materialized_view'
      WHEN 'f' THEN 'foreign_table'
      WHEN 'S' THEN 'sequence'
      WHEN 'i' THEN 'index'
      WHEN 'I' THEN 'partitioned_index'
      WHEN 'c' THEN 'composite_relation'
      ELSE 'relation_' || class.relkind::text
    END AS kind,
    class.relname::text AS name,
    owner.relname::text AS owner_table,
    CASE WHEN class.relkind IN ('i', 'I') THEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint constraint_record WHERE constraint_record.conindid = class.oid
    ) ELSE false END AS constraint_index,
    CASE WHEN class.relkind IN ('i', 'I') THEN pg_catalog.jsonb_build_object(
      'access_method', access_method.amname,
      'unique', index_record.indisunique,
      'primary', index_record.indisprimary,
      'exclusion', index_record.indisexclusion,
      'immediate', index_record.indimmediate,
      'valid', index_record.indisvalid,
      'ready', index_record.indisready,
      'live', index_record.indislive,
      'replica_identity', index_record.indisreplident,
      'nulls_not_distinct', index_record.indnullsnotdistinct,
      'key_count', index_record.indnkeyatts,
      'attributes', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'position', key.ordinality,
          'column', attribute.attname,
          'definition', pg_catalog.pg_get_indexdef(class.oid, key.ordinality::integer, false),
          'opclass', operator_class.opcname,
          'collation', collation_record.collname,
          'option', (index_record.indoption)[(key.ordinality - 1)::integer]
        ) ORDER BY key.ordinality)
        FROM pg_catalog.unnest(index_record.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
        LEFT JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = index_record.indrelid AND attribute.attnum = key.attnum
        LEFT JOIN pg_catalog.pg_opclass operator_class
          ON operator_class.oid = (index_record.indclass)[(key.ordinality - 1)::integer]
        LEFT JOIN pg_catalog.pg_collation collation_record
          ON collation_record.oid = (index_record.indcollation)[(key.ordinality - 1)::integer]
      ),
      'predicate', pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid, false)
    ) ELSE NULL::jsonb END AS signature
  FROM pg_catalog.pg_class class
  JOIN target_namespace namespace ON namespace.oid = class.relnamespace
  LEFT JOIN pg_catalog.pg_index index_record ON index_record.indexrelid = class.oid
  LEFT JOIN pg_catalog.pg_class owner ON owner.oid = index_record.indrelid
  LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid = class.relam

  UNION ALL

  SELECT
    CASE
      WHEN row_relation.relkind = 'r' THEN 'table_row_type'
      WHEN element_relation.relkind = 'r' THEN 'table_row_array_type'
      WHEN type_record.typtype = 'd' THEN 'domain'
      WHEN type_record.typtype = 'e' THEN 'enum'
      WHEN type_record.typtype = 'c' THEN 'composite_type'
      WHEN type_record.typtype = 'r' THEN 'range_type'
      WHEN type_record.typtype = 'm' THEN 'multirange_type'
      WHEN type_record.typtype = 'p' THEN 'pseudo_type'
      ELSE 'custom_type'
    END AS kind,
    type_record.typname::text AS name,
    COALESCE(row_relation.relname, element_relation.relname)::text AS owner_table,
    false AS constraint_index,
    NULL::jsonb AS signature
  FROM pg_catalog.pg_type type_record
  JOIN target_namespace namespace ON namespace.oid = type_record.typnamespace
  LEFT JOIN pg_catalog.pg_class row_relation ON row_relation.oid = type_record.typrelid
  LEFT JOIN pg_catalog.pg_type element_type ON element_type.oid = type_record.typelem
  LEFT JOIN pg_catalog.pg_class element_relation ON element_relation.oid = element_type.typrelid

  UNION ALL

  SELECT
    CASE procedure_record.prokind
      WHEN 'p' THEN 'procedure'
      WHEN 'a' THEN 'aggregate'
      WHEN 'w' THEN 'window_function'
      ELSE 'function'
    END AS kind,
    (procedure_record.proname || '(' || pg_catalog.pg_get_function_identity_arguments(procedure_record.oid) || ')')::text AS name,
    NULL::text AS owner_table,
    false AS constraint_index,
    NULL::jsonb AS signature
  FROM pg_catalog.pg_proc procedure_record
  JOIN target_namespace namespace ON namespace.oid = procedure_record.pronamespace

  UNION ALL
  SELECT 'collation', record.collname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_collation record JOIN target_namespace namespace ON namespace.oid = record.collnamespace
  UNION ALL
  SELECT 'conversion', record.conname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_conversion record JOIN target_namespace namespace ON namespace.oid = record.connamespace
  UNION ALL
  SELECT 'operator', record.oprname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_operator record JOIN target_namespace namespace ON namespace.oid = record.oprnamespace
  UNION ALL
  SELECT 'operator_class', record.opcname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_opclass record JOIN target_namespace namespace ON namespace.oid = record.opcnamespace
  UNION ALL
  SELECT 'operator_family', record.opfname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_opfamily record JOIN target_namespace namespace ON namespace.oid = record.opfnamespace
  UNION ALL
  SELECT 'text_search_configuration', record.cfgname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_ts_config record JOIN target_namespace namespace ON namespace.oid = record.cfgnamespace
  UNION ALL
  SELECT 'text_search_dictionary', record.dictname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_ts_dict record JOIN target_namespace namespace ON namespace.oid = record.dictnamespace
  UNION ALL
  SELECT 'text_search_parser', record.prsname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_ts_parser record JOIN target_namespace namespace ON namespace.oid = record.prsnamespace
  UNION ALL
  SELECT 'text_search_template', record.tmplname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_ts_template record JOIN target_namespace namespace ON namespace.oid = record.tmplnamespace
  UNION ALL
  SELECT 'extended_statistics', record.stxname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_statistic_ext record JOIN target_namespace namespace ON namespace.oid = record.stxnamespace
  UNION ALL
  SELECT 'extension', record.extname::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_extension record JOIN target_namespace namespace ON namespace.oid = record.extnamespace
  UNION ALL
  SELECT 'row_security_policy', policy.polname::text, class.relname::text, false, NULL::jsonb
    FROM pg_catalog.pg_policy policy
    JOIN pg_catalog.pg_class class ON class.oid = policy.polrelid
    JOIN target_namespace namespace ON namespace.oid = class.relnamespace
  UNION ALL
  SELECT 'trigger', trigger_record.tgname::text, class.relname::text, false, NULL::jsonb
    FROM pg_catalog.pg_trigger trigger_record
    JOIN pg_catalog.pg_class class ON class.oid = trigger_record.tgrelid
    JOIN target_namespace namespace ON namespace.oid = class.relnamespace
   WHERE NOT trigger_record.tgisinternal
  UNION ALL
  SELECT 'rewrite_rule', rule.rulename::text, class.relname::text, false, NULL::jsonb
    FROM pg_catalog.pg_rewrite rule
    JOIN pg_catalog.pg_class class ON class.oid = rule.ev_class
    JOIN target_namespace namespace ON namespace.oid = class.relnamespace
   WHERE rule.rulename <> '_RETURN'
  UNION ALL
  SELECT 'default_acl', (pg_catalog.pg_get_userbyid(record.defaclrole) || ':' || record.defaclobjtype::text)::text, NULL::text, false, NULL::jsonb
    FROM pg_catalog.pg_default_acl record JOIN target_namespace namespace ON namespace.oid = record.defaclnamespace

  UNION ALL

  SELECT
    'constraint'::text AS kind,
    constraint_record.conname::text AS name,
    owner.relname::text AS owner_table,
    false AS constraint_index,
    pg_catalog.jsonb_build_object(
      'type', constraint_record.contype,
      'columns', (
        SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key.ordinality)
          FROM pg_catalog.unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, ordinality)
          JOIN pg_catalog.pg_attribute attribute
            ON attribute.attrelid = constraint_record.conrelid AND attribute.attnum = key.attnum
      ),
      'referenced_table', referenced.relname,
      'referenced_columns', (
        SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key.ordinality)
          FROM pg_catalog.unnest(constraint_record.confkey) WITH ORDINALITY AS key(attnum, ordinality)
          JOIN pg_catalog.pg_attribute attribute
            ON attribute.attrelid = constraint_record.confrelid AND attribute.attnum = key.attnum
      ),
      'match_type', constraint_record.confmatchtype,
      'on_update', constraint_record.confupdtype,
      'on_delete', constraint_record.confdeltype,
      'deferrable', constraint_record.condeferrable,
      'initially_deferred', constraint_record.condeferred,
      'validated', constraint_record.convalidated,
      'no_inherit', constraint_record.connoinherit,
      'expression', pg_catalog.pg_get_expr(constraint_record.conbin, constraint_record.conrelid, false)
    ) AS signature
  FROM pg_catalog.pg_constraint constraint_record
  JOIN pg_catalog.pg_class owner ON owner.oid = constraint_record.conrelid
  JOIN target_namespace namespace ON namespace.oid = owner.relnamespace
  LEFT JOIN pg_catalog.pg_class referenced ON referenced.oid = constraint_record.confrelid
)
SELECT kind, name, owner_table, constraint_index, signature
FROM objects
ORDER BY kind, name, owner_table NULLS FIRST`;

const EXPECTED_INVENTORY_BY_RESULT = new WeakMap();
const CANONICAL_INVENTORY_BY_CLIENT = new WeakMap();

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function normalizedSignature(value) {
  if (value == null) return null;
  return canonicalJson(typeof value === "string" ? JSON.parse(value) : value);
}

function normalizedObject(raw) {
  return {
    kind: String(raw?.kind ?? ""),
    name: String(raw?.name ?? ""),
    owner_table: raw?.owner_table == null ? null : String(raw.owner_table),
    constraint_index: raw?.constraint_index === true,
    signature: normalizedSignature(raw?.signature),
  };
}

async function listSchemaObjects(client, schemaName) {
  const result = await client.query(SCHEMA_OBJECTS_SQL, [schemaName]);
  return result.rows.map(normalizedObject);
}

async function materializeCanonicalBaseline(client) {
  const files = await migrations();
  await client.query("BEGIN");
  try {
    // PostgreSQL canonicalizes both copies on the same server/version. The
    // reference objects are session-local and the transaction is always rolled back.
    await client.query("CREATE TEMP TABLE longhub_canonical_schema_seed(value integer) ON COMMIT DROP");
    await client.query("DROP TABLE pg_temp.longhub_canonical_schema_seed");
    await client.query("SET LOCAL search_path TO pg_temp");
    for (const file of files) await client.query(file.bytes.toString("utf8"));
    const namespaceResult = await client.query(`
      SELECT nspname::text AS name
        FROM pg_catalog.pg_namespace
       WHERE oid = pg_catalog.pg_my_temp_schema()`);
    if (namespaceResult.rowCount !== 1) throw new Error("failed to create canonical temporary schema inventory");
    const expected = await listSchemaObjects(client, namespaceResult.rows[0].name);
    await client.query("ROLLBACK");
    return expected;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function canonicalBaselineForClient(client) {
  let pending = CANONICAL_INVENTORY_BY_CLIENT.get(client);
  if (!pending) {
    pending = materializeCanonicalBaseline(client);
    CANONICAL_INVENTORY_BY_CLIENT.set(client, pending);
  }
  try {
    return await pending;
  } catch (error) {
    CANONICAL_INVENTORY_BY_CLIENT.delete(client);
    throw error;
  }
}

export async function listPublicSchemaObjects(client) {
  const objects = await listSchemaObjects(client, "public");
  const expected = await canonicalBaselineForClient(client);
  EXPECTED_INVENTORY_BY_RESULT.set(objects, expected);
  return objects;
}

export function detectPublicSchemaPhase(objects) {
  return objects.some((raw) => {
    const object = normalizedObject(raw);
    return object.kind === "table" && object.name !== "schema_migrations";
  }) ? "baseline" : "bootstrap";
}

function objectIdentity(object) {
  return `${object.kind}:${object.name}${object.owner_table ? ` on ${object.owner_table}` : ""}`;
}

function objectDefinition(object) {
  return JSON.stringify({ constraint_index: object.constraint_index, signature: object.signature });
}

function belongsToBootstrap(object) {
  return (object.name === "schema_migrations" && object.kind === "table")
    || (object.owner_table === "schema_migrations"
      && ["index", "constraint", "table_row_type", "table_row_array_type"].includes(object.kind));
}

export function validatePublicSchemaObjects(objects, {
  phase = "bootstrap",
  requireComplete = false,
  expectedBaselineObjects,
} = {}) {
  if (phase !== "bootstrap" && phase !== "baseline") throw new Error(`invalid public schema validation phase: ${phase}`);
  if (!Array.isArray(objects)) throw new Error("public schema object inventory must be an array");

  const allowedTables = new Set(phase === "baseline" ? EXPECTED_CLEAN_LAUNCH_TABLES : ["schema_migrations"]);
  const allowedSequences = new Set(phase === "baseline" ? EXPECTED_CLEAN_LAUNCH_SEQUENCES : []);
  const normalized = objects.map(normalizedObject);
  const forbiddenTables = normalized
    .filter((object) => object.kind === "table" && FORBIDDEN.includes(object.name))
    .map((object) => object.name);
  if (forbiddenTables.length) throw new Error(`forbidden historical tables exist: ${forbiddenTables.join(", ")}`);

  const expectedSource = expectedBaselineObjects ?? EXPECTED_INVENTORY_BY_RESULT.get(objects);
  if (expectedSource !== undefined && !Array.isArray(expectedSource)) {
    throw new Error("canonical baseline schema object inventory must be an array");
  }
  const expected = expectedSource?.map(normalizedObject)
    .filter((object) => phase === "baseline" || belongsToBootstrap(object));
  if (!expected && normalized.length > 0) {
    throw new Error("canonical baseline schema object inventory is required for non-empty validation");
  }
  const expectedByIdentity = new Map((expected ?? []).map((object) => [objectIdentity(object), object]));

  const violations = [];
  const altered = [];
  for (const object of normalized) {
    let allowed = false;
    if (object.kind === "table") {
      allowed = allowedTables.has(object.name);
    } else if (object.kind === "sequence") {
      allowed = allowedSequences.has(object.name);
    } else if (["index", "constraint", "table_row_type", "table_row_array_type"].includes(object.kind)) {
      allowed = expectedByIdentity.has(objectIdentity(object));
    }
    if (!allowed) {
      violations.push(objectIdentity(object));
      continue;
    }
    const expectedObject = expectedByIdentity.get(objectIdentity(object));
    if (expectedObject && objectDefinition(object) !== objectDefinition(expectedObject)) {
      altered.push(objectIdentity(object));
    }
  }
  if (violations.length) throw new Error(`unexpected public schema objects: ${violations.join(", ")}`);
  if (altered.length) throw new Error(`altered public schema definitions: ${altered.join(", ")}`);

  const tables = [...new Set(normalized.filter((object) => object.kind === "table").map((object) => object.name))].sort();
  const sequences = [...new Set(normalized.filter((object) => object.kind === "sequence").map((object) => object.name))].sort();
  if (requireComplete) {
    const missingTables = EXPECTED_CLEAN_LAUNCH_TABLES.filter((name) => !tables.includes(name));
    const missingSequences = EXPECTED_CLEAN_LAUNCH_SEQUENCES.filter((name) => !sequences.includes(name));
    if (missingTables.length || missingSequences.length) {
      const details = [];
      if (missingTables.length) details.push(`tables: ${missingTables.join(", ")}`);
      if (missingSequences.length) details.push(`sequences: ${missingSequences.join(", ")}`);
      throw new Error(`clean-launch baseline is incomplete; missing ${details.join("; ")}`);
    }
    const actualIdentities = new Set(normalized.map(objectIdentity));
    const missingDefinitions = (expected ?? [])
      .map(objectIdentity)
      .filter((identity) => !actualIdentities.has(identity));
    if (missingDefinitions.length) {
      throw new Error(`clean-launch baseline is incomplete; missing definitions: ${missingDefinitions.join(", ")}`);
    }
  }
  return { tables, sequences };
}

export function validatePinnedMigrationSet(files) {
  if (!Array.isArray(files)) throw new Error("clean-launch migration inventory must be an array");
  const actualByFilename = new Map(files.map((file) => [String(file?.filename ?? ""), file]));
  const expectedByFilename = new Map(PINNED_CLEAN_LAUNCH_MIGRATIONS.map((file) => [file.filename, file]));
  const unexpected = [...actualByFilename.keys()].filter((filename) => !expectedByFilename.has(filename));
  const missing = [...expectedByFilename.keys()].filter((filename) => !actualByFilename.has(filename));
  if (unexpected.length || missing.length || actualByFilename.size !== files.length) {
    const details = [];
    if (unexpected.length) details.push(`unexpected: ${unexpected.join(", ")}`);
    if (missing.length) details.push(`missing: ${missing.join(", ")}`);
    if (actualByFilename.size !== files.length) details.push("duplicate filenames");
    throw new Error(`clean-launch pinned migration set mismatch; ${details.join("; ")}`);
  }
  for (const expected of PINNED_CLEAN_LAUNCH_MIGRATIONS) {
    const actual = actualByFilename.get(expected.filename);
    if (String(actual?.version ?? "") !== expected.version
      || String(actual?.name ?? "") !== expected.name
      || String(actual?.checksum ?? "") !== expected.checksum) {
      throw new Error(`clean-launch pinned migration identity/checksum mismatch: ${expected.filename}`);
    }
  }
  return files;
}

async function migrations() {
  const entries = await readdir(DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".sql")) continue;
    if (entry.isSymbolicLink()) throw new Error(`symlink migration is not allowed: ${entry.name}`);
    const match = FILE_RE.exec(entry.name);
    if (!match?.groups) throw new Error(`invalid clean-launch migration filename: ${entry.name}`);
    const path = resolve(DIR, entry.name);
    const rel = relative(DIR, path);
    if (rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) throw new Error("migration path escaped clean-launch directory");
    if (!(await stat(path)).isFile()) throw new Error(`migration is not a regular file: ${entry.name}`);
    const bytes = await readFile(path);
    result.push({ version: match.groups.version, name: match.groups.name, filename: entry.name, bytes,
      checksum: createHash("sha256").update(bytes).digest("hex") });
  }
  result.sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 1; i < result.length; i += 1) if (result[i - 1].version === result[i].version) throw new Error(`duplicate migration version: ${result[i].version}`);
  if (!result.length) throw new Error(`no migrations in ${DIR}`);
  return validatePinnedMigrationSet(result);
}

async function ensureSchemaMigrations(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function applied(client) {
  const result = await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  return new Map(result.rows.map((row) => [row.version, row]));
}

function hasSchemaMigrations(objects) {
  return objects.some((raw) => {
    const object = normalizedObject(raw);
    return object.kind === "table" && object.name === "schema_migrations";
  });
}

export function migrationRunSummary(executedFilenames, tables) {
  return { applied: [...executedFilenames], tables: [...tables] };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = [...argv];
  // pnpm may preserve the separator when invoking a package script. Accept one
  // separator only; no path argument is ever accepted.
  if (args[0] === "--") args.shift();
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error("usage: DATABASE_URL=... node apps/longhub-cloud-api/scripts/migrate.mjs [--dry-run]");
  }
  const dryRun = args[0] === "--dry-run";
  if (!environment.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const files = await migrations();
  const client = new pg.Client({ connectionString: environment.DATABASE_URL });
  await client.connect();
  let locked = false;
  try {
    await client.query("SET search_path TO public");
    await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK.toString()]);
    locked = true;

    const beforeObjects = await listPublicSchemaObjects(client);
    const beforePhase = detectPublicSchemaPhase(beforeObjects);
    validatePublicSchemaObjects(beforeObjects, {
      phase: beforePhase,
      requireComplete: beforePhase === "baseline",
    });

    if (dryRun) {
      const records = hasSchemaMigrations(beforeObjects) ? await applied(client) : new Map();
      for (const record of records.values()) {
        if (!files.some((file) => file.version === record.version)) throw new Error(`unknown migration record: ${record.version}`);
      }
      for (const file of files) {
        const record = records.get(file.version);
        if (record && (record.name !== file.name || record.checksum !== file.checksum)) throw new Error(`migration checksum/name mismatch: ${file.filename}`);
      }
      process.stdout.write(JSON.stringify({ dry_run: true, pending: files.filter((file) => !records.has(file.version)).map(({ filename, checksum }) => ({ filename, checksum })) }) + "\n");
      return;
    }

    await ensureSchemaMigrations(client);
    const records = await applied(client);
    const executed = [];
    for (const record of records.values()) {
      if (!files.some((file) => file.version === record.version)) throw new Error(`unknown migration record: ${record.version}`);
    }
    for (const file of files) {
      const record = records.get(file.version);
      if (record) {
        if (record.name !== file.name || record.checksum !== file.checksum) throw new Error(`migration checksum/name mismatch: ${file.filename}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(file.bytes.toString("utf8"));
        await client.query("INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)", [file.version, file.name, file.checksum]);
        await client.query("COMMIT");
        executed.push(file.filename);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }

      const afterEachObjects = await listPublicSchemaObjects(client);
      validatePublicSchemaObjects(afterEachObjects, { phase: "baseline", requireComplete: true });
    }

    const afterObjects = await listPublicSchemaObjects(client);
    const validated = validatePublicSchemaObjects(afterObjects, { phase: "baseline", requireComplete: true });
    process.stdout.write(JSON.stringify(migrationRunSummary(executed, validated.tables)) + "\n");
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK.toString()]).catch(() => undefined);
    await client.end();
  }
}

const directEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (directEntry === fileURLToPath(import.meta.url)) await main();
