#!/usr/bin/env node
// Post-migration schema smoke helper. The active migration runner lives at
// apps/longhub-cloud-api/scripts/migrate.mjs; this file is intentionally not
// scanned by that runner because it is not named NNNN-*.sql. Reuse the same
// catalog inventory/allow-list so the smoke check cannot drift from deploys.
import { createRequire } from "node:module";
import {
  listPublicSchemaObjects,
  validatePublicSchemaObjects,
} from "../../../apps/longhub-cloud-api/scripts/migrate.mjs";

// pnpm exposes pg only to the Cloud API package that declares it.
const requireFromCloudApi = createRequire(
  new URL("../../../apps/longhub-cloud-api/package.json", import.meta.url),
);
const pg = requireFromCloudApi("pg");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const objects = await listPublicSchemaObjects(client);
  const validated = validatePublicSchemaObjects(objects, { phase: "baseline", requireComplete: true });
  const legacyColumns = [
    ["account_user", "balance_fen"],
    ["device", "device_token"], ["device", "activation_code_id"], ["device", "activated_at"],
    ["billing_order", "product_id"], ["billing_order", "pack_id"],
    ["model_gateway_config", "assistant_name"], ["model_gateway_config", "assistant_avatar_path"],
    ["model_gateway_config", "welcome_message"], ["model_gateway_config", "quick_tasks"],
    ["model_gateway_config", "features"],
  ];
  for (const [table, column] of legacyColumns) {
    const result = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
      [table, column],
    );
    if (result.rowCount) throw new Error(`legacy column exists: ${table}.${column}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, tables: validated.tables, sequences: validated.sequences }) + "\n");
} finally {
  await client.end();
}
