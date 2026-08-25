#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import {
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_REQUEST_SCHEMA,
  computeExecutorInputDigest,
  issueExecutorCredential,
  parseExecutorCredentialKey,
} from "../../../apps/longhub-executor/dist/index.js";

const requireFromCloudApi = createRequire(
  new URL("../../../apps/longhub-cloud-api/package.json", import.meta.url),
);
const { Client } = requireFromCloudApi("pg");

async function readEnvironment(path) {
  const values = {};
  const lines = (await readFile(path, "utf8")).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/u, "");
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`invalid environment record in ${path}:${index + 1}`);
    const [, name, encodedValue] = match;
    if (Object.hasOwn(values, name)) {
      throw new Error(`duplicate ${name} in ${path}`);
    }
    let value = encodedValue;
    if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'") || value.slice(1, -1).includes("'")) {
        throw new Error(`unsupported quoted value for ${name} in ${path}`);
      }
      value = value.slice(1, -1);
    } else if (/\s/u.test(value) || value.startsWith('"')) {
      throw new Error(`unsupported value syntax for ${name} in ${path}`);
    }
    values[name] = value;
  }
  return Object.freeze(values);
}

function assertOnlyKeys(environment, allowed, label) {
  const unexpected = Object.keys(environment).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected settings: ${unexpected.join(", ")}`);
  }
}

function parseDatabaseUrl(value, label) {
  if (!value) throw new Error(`${label} DATABASE_URL is missing`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} DATABASE_URL is invalid`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
      parsed.username.length === 0 || parsed.password.length === 0 || parsed.hostname.length === 0 ||
      parsed.pathname.length < 2 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${label} DATABASE_URL must contain a PostgreSQL role, password and database`);
  }
  return parsed;
}

function databaseEndpoint(url) {
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

const cloudEnvironment = await readEnvironment("/etc/longhub/cloud-api.env");
const executorEnvironment = await readEnvironment("/etc/longhub/executor.env");
const migrateEnvironment = await readEnvironment("/etc/longhub/migrate.env");
const siteEnvironment = await readEnvironment("/etc/longhub/site.env");

assertOnlyKeys(migrateEnvironment, new Set(["DATABASE_URL"]), "migrate.env");
assertOnlyKeys(executorEnvironment, new Set([
  "NODE_ENV",
  "PORT",
  "EXECUTOR_BIND_HOST",
  "EXECUTOR_CREDENTIAL_SECRET",
  "EXECUTOR_CREDENTIAL_KEY_ID",
  "EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON",
]), "executor.env");
const siteKeys = new Set([
  "LONGHUB_SERVER_NAME",
  "LONGHUB_TLS_CERTIFICATE",
  "LONGHUB_TLS_CERTIFICATE_KEY",
  "LONGHUB_CLIENT_RELEASE_DIR",
  "LONGHUB_CLOUD_PLUGIN_RELEASE_DIR",
  "LONGHUB_CLOUD_CLI_RELEASE_DIR",
  "LONGHUB_CLOUD_API_UPSTREAM",
  "LONGHUB_WEB_ROOT",
]);
assertOnlyKeys(siteEnvironment, siteKeys, "site.env");
if (Object.keys(siteEnvironment).length !== siteKeys.size ||
    [...siteKeys].some((name) => !siteEnvironment[name]) ||
    siteEnvironment.LONGHUB_CLIENT_RELEASE_DIR !== "/var/lib/longhub/client-releases" ||
    siteEnvironment.LONGHUB_CLOUD_PLUGIN_RELEASE_DIR !== "/var/lib/longhub/cloud-plugin-releases" ||
    siteEnvironment.LONGHUB_CLOUD_CLI_RELEASE_DIR !== "/var/lib/longhub/cloud-cli-releases" ||
    siteEnvironment.LONGHUB_WEB_ROOT !== "/var/www/longhub/current") {
  throw new Error("site.env does not match the installed release layout");
}
const cloudBindHost = cloudEnvironment.CLOUD_API_BIND_HOST || "127.0.0.1";
const cloudPort = cloudEnvironment.PORT || "8081";
if (siteEnvironment.LONGHUB_CLOUD_API_UPSTREAM !== `${cloudBindHost}:${cloudPort}` ||
    cloudBindHost !== "127.0.0.1") {
  throw new Error("Nginx and Cloud API loopback endpoints do not match");
}
if (process.argv[2]) {
  const healthOrigin = new URL(process.argv[2]);
  if (healthOrigin.protocol !== "https:" || healthOrigin.pathname !== "/" ||
      healthOrigin.search || healthOrigin.hash || healthOrigin.hostname !== siteEnvironment.LONGHUB_SERVER_NAME) {
    throw new Error("health origin does not match LONGHUB_SERVER_NAME");
  }
}
for (const seedName of ["ADMIN_SEED_USERNAME", "ADMIN_SEED_PASSWORD"]) {
  if (Object.hasOwn(cloudEnvironment, seedName)) {
    throw new Error(`${seedName} must be removed after the one-time Admin seed`);
  }
}

const cloudKey = parseExecutorCredentialKey(cloudEnvironment);
const executorKey = parseExecutorCredentialKey(executorEnvironment);
if (!cloudKey || !executorKey || cloudKey.keyId !== executorKey.keyId ||
  cloudKey.secret.length !== executorKey.secret.length ||
  !timingSafeEqual(cloudKey.secret, executorKey.secret)) {
  throw new Error("Cloud API and Executor credential keys do not match");
}

const appDatabaseUrl = parseDatabaseUrl(cloudEnvironment.DATABASE_URL, "Cloud API");
const migratorDatabaseUrl = parseDatabaseUrl(migrateEnvironment.DATABASE_URL, "Migrator");
if (decodeURIComponent(appDatabaseUrl.username) !== "longhub_app" ||
    decodeURIComponent(migratorDatabaseUrl.username) !== "longhub_migrator") {
  throw new Error("database URLs do not use the required runtime and migrator identities");
}
if (databaseEndpoint(appDatabaseUrl) !== databaseEndpoint(migratorDatabaseUrl)) {
  throw new Error("runtime and migrator database URLs do not target the same database");
}
if (decodeURIComponent(appDatabaseUrl.password) === decodeURIComponent(migratorDatabaseUrl.password)) {
  throw new Error("runtime and migrator database roles must use different passwords");
}

const database = new Client({
  connectionString: appDatabaseUrl.toString(),
  application_name: "longhub-runtime-probe",
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
  statement_timeout: 5_000,
});
try {
  await database.connect();
  const identityResult = await database.query(`
    SELECT
      current_user AS role_name,
      role.rolcanlogin,
      role.rolinherit,
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls,
      has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
      has_database_privilege(current_user, current_database(), 'TEMP') AS can_create_temp_objects,
      has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_objects,
      (
        SELECT COUNT(*)::integer
        FROM pg_auth_members AS membership
        WHERE membership.member = role.oid
      ) AS role_memberships
    FROM pg_roles AS role
    WHERE role.rolname = current_user
  `);
  const identity = identityResult.rows[0];
  if (!identity || identity.role_name !== "longhub_app" || !identity.rolcanlogin || identity.rolinherit ||
      identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolreplication ||
      identity.rolbypassrls || !identity.can_connect || identity.can_create_database_objects ||
      identity.can_create_temp_objects || !identity.can_use_schema || identity.can_create_schema_objects ||
      identity.role_memberships !== 0) {
    throw new Error("PostgreSQL runtime identity is not DML-only");
  }

  const databaseResult = await database.query(`
    SELECT
      COUNT(*) FILTER (WHERE target.datname = current_database())::integer AS current_databases,
      COUNT(*) FILTER (
        WHERE target.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      )::integer AS owned_databases,
      COUNT(*) FILTER (
        WHERE target.datname = current_database() AND NOT (
          has_database_privilege(current_user, target.oid, 'CONNECT') AND
          NOT has_database_privilege(current_user, target.oid, 'CREATE') AND
          NOT has_database_privilege(current_user, target.oid, 'TEMP')
        )
      )::integer AS invalid_current_database_access,
      COUNT(*) FILTER (
        WHERE target.datname <> current_database() AND (
          has_database_privilege(current_user, target.oid, 'CONNECT') OR
          has_database_privilege(current_user, target.oid, 'CREATE') OR
          has_database_privilege(current_user, target.oid, 'TEMP')
        )
      )::integer AS unexpected_other_database_access
    FROM pg_database AS target
  `);
  const databases = databaseResult.rows[0];
  if (!databases || databases.current_databases !== 1 || databases.owned_databases !== 0 ||
      databases.invalid_current_database_access !== 0 || databases.unexpected_other_database_access !== 0) {
    throw new Error("PostgreSQL runtime role has privileges outside its application database");
  }

  const schemaResult = await database.query(`
    SELECT
      COUNT(*) FILTER (WHERE namespace.nspname = 'public')::integer AS public_schemas,
      COUNT(*) FILTER (
        WHERE namespace.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      )::integer AS owned_schemas,
      COUNT(*) FILTER (
        WHERE namespace.nspname = 'public' AND NOT (
          has_schema_privilege(current_user, namespace.oid, 'USAGE') AND
          NOT has_schema_privilege(current_user, namespace.oid, 'CREATE')
        )
      )::integer AS invalid_public_schema_access,
      COUNT(*) FILTER (
        WHERE namespace.nspname <> 'public' AND (
          has_schema_privilege(current_user, namespace.oid, 'USAGE') OR
          has_schema_privilege(current_user, namespace.oid, 'CREATE')
        )
      )::integer AS unexpected_schema_access
    FROM pg_namespace AS namespace
    WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'
  `);
  const schemas = schemaResult.rows[0];
  if (!schemas || schemas.public_schemas !== 1 || schemas.owned_schemas !== 0 ||
      schemas.invalid_public_schema_access !== 0 || schemas.unexpected_schema_access !== 0) {
    throw new Error("PostgreSQL runtime schema grants are not least-privilege");
  }

  const tableResult = await database.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND
          relation.relname <> 'schema_migrations'
      )::integer AS domain_tables,
      COUNT(*) FILTER (
        WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND
          relation.relname <> 'schema_migrations' AND NOT (
          has_table_privilege(current_user, relation.oid, 'SELECT') AND
          has_table_privilege(current_user, relation.oid, 'INSERT') AND
          has_table_privilege(current_user, relation.oid, 'UPDATE') AND
          has_table_privilege(current_user, relation.oid, 'DELETE')
        )
      )::integer AS missing_dml,
      COUNT(*) FILTER (
        WHERE
          has_table_privilege(current_user, relation.oid, 'TRUNCATE') OR
          has_table_privilege(current_user, relation.oid, 'REFERENCES') OR
          has_table_privilege(current_user, relation.oid, 'TRIGGER') OR
          (
            (namespace.nspname <> 'public' OR relation.relkind NOT IN ('r', 'p')) AND (
              has_table_privilege(current_user, relation.oid, 'SELECT') OR
              has_table_privilege(current_user, relation.oid, 'INSERT') OR
              has_table_privilege(current_user, relation.oid, 'UPDATE') OR
              has_table_privilege(current_user, relation.oid, 'DELETE')
            )
          )
      )::integer AS forbidden_table_privileges,
      COUNT(*) FILTER (WHERE relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))::integer
        AS owned_relations
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_' AND
      relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  `);
  const tables = tableResult.rows[0];
  if (!tables || tables.domain_tables < 1 || tables.missing_dml !== 0 ||
      tables.forbidden_table_privileges !== 0 || tables.owned_relations !== 0) {
    throw new Error("PostgreSQL runtime table grants are not DML-only");
  }

  const migrationTableResult = await database.query(`
    SELECT
      to_regclass('public.schema_migrations') IS NOT NULL AS present,
      has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'public.schema_migrations', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'public.schema_migrations', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'public.schema_migrations', 'DELETE') AS can_delete
  `);
  const migrationTable = migrationTableResult.rows[0];
  if (!migrationTable?.present || !migrationTable.can_select || migrationTable.can_insert ||
      migrationTable.can_update || migrationTable.can_delete) {
    throw new Error("schema_migrations must be read-only to the runtime role");
  }

  const sequenceResult = await database.query(`
    SELECT
      COUNT(*) FILTER (WHERE namespace.nspname = 'public')::integer AS sequences,
      COUNT(*) FILTER (
        WHERE namespace.nspname = 'public' AND (
          NOT has_sequence_privilege(current_user, relation.oid, 'USAGE') OR
          NOT has_sequence_privilege(current_user, relation.oid, 'SELECT')
        )
      )::integer AS missing_sequence_access,
      COUNT(*) FILTER (
        WHERE has_sequence_privilege(current_user, relation.oid, 'UPDATE') OR
          (
            namespace.nspname <> 'public' AND (
              has_sequence_privilege(current_user, relation.oid, 'USAGE') OR
              has_sequence_privilege(current_user, relation.oid, 'SELECT')
            )
          )
      )::integer AS forbidden_sequence_access,
      COUNT(*) FILTER (
        WHERE relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      )::integer AS owned_sequences
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_' AND
      relation.relkind = 'S'
  `);
  const sequences = sequenceResult.rows[0];
  if (!sequences || sequences.sequences < 1 || sequences.missing_sequence_access !== 0 ||
      sequences.forbidden_sequence_access !== 0 || sequences.owned_sequences !== 0) {
    throw new Error("PostgreSQL runtime sequence grants are not least-privilege");
  }

  const functionResult = await database.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE has_function_privilege(current_user, routine.oid, 'EXECUTE')
      )::integer AS executable_functions,
      COUNT(*) FILTER (
        WHERE routine.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      )::integer AS owned_functions
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'
  `);
  const functions = functionResult.rows[0];
  if (!functions || functions.executable_functions !== 0 || functions.owned_functions !== 0) {
    throw new Error("PostgreSQL runtime role can execute or own non-system functions");
  }
} finally {
  await database.end().catch(() => undefined);
}

let executorUrl;
try {
  executorUrl = new URL(cloudEnvironment.EXECUTOR_URL);
} catch {
  throw new Error("Cloud API EXECUTOR_URL is invalid");
}
const executorHost = executorEnvironment.EXECUTOR_BIND_HOST || "127.0.0.1";
const executorPort = executorEnvironment.PORT || "8082";
const executorUrlHost = executorUrl.hostname.replace(/^\[|\]$/gu, "");
const executorIpVersion = isIP(executorHost);
const executorIsLoopback = (executorIpVersion === 4 && executorHost.split(".")[0] === "127") ||
  (executorIpVersion === 6 && executorHost === "::1");
if (executorUrl.protocol !== "http:" || executorUrl.username || executorUrl.password ||
    executorUrl.search || executorUrl.hash || executorUrl.pathname !== "/" ||
    executorUrlHost !== executorHost || (executorUrl.port || "80") !== executorPort ||
    !executorIsLoopback) {
  throw new Error("Cloud API and Executor loopback endpoints do not match");
}

const input = { level: 3 };
const taskId = `health-${Date.now()}`;
const tenantId = "staging-health";
const skillId = "longhub.skill.salary-band";
const idempotencyKey = taskId;
const credential = issueExecutorCredential(
  { taskId, tenantId, skillId, idempotencyKey, input },
  { key: cloudKey },
);
const response = await fetch(new URL("execute", executorUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    [EXECUTOR_CREDENTIAL_HEADER]: credential,
  },
  body: JSON.stringify({
    schema_version: EXECUTOR_REQUEST_SCHEMA,
    task_id: taskId,
    tenant_id: tenantId,
    skill_id: skillId,
    idempotency_key: idempotencyKey,
    input_digest: computeExecutorInputDigest(input),
    input,
  }),
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json().catch(() => ({}));
if (response.status !== 200 || body.output?.level !== 3 || body.output?.currency !== "CNY") {
  throw new Error(`signed Executor probe failed with status ${response.status}`);
}

process.stdout.write("LongHub runtime probe: OK\n");
