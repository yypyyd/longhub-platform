import { describe, expect, it } from "vitest";
import {
  detectPublicSchemaPhase,
  EXPECTED_CLEAN_LAUNCH_SEQUENCES,
  EXPECTED_CLEAN_LAUNCH_TABLES,
  migrationRunSummary,
  PINNED_CLEAN_LAUNCH_MIGRATIONS,
  validatePinnedMigrationSet,
  validatePublicSchemaObjects,
} from "../scripts/migrate.mjs";

type SchemaObject = {
  kind: string;
  name: string;
  owner_table?: string | null;
  constraint_index?: boolean;
  signature?: unknown;
};

function table(name: string): SchemaObject {
  return { kind: "table", name, owner_table: null, constraint_index: false, signature: null };
}

function index(
  name: string,
  ownerTable: string,
  columns: string[],
  { constraint = false, unique = false, predicate = null }: {
    constraint?: boolean;
    unique?: boolean;
    predicate?: string | null;
  } = {},
): SchemaObject {
  return {
    kind: "index",
    name,
    owner_table: ownerTable,
    constraint_index: constraint,
    signature: {
      access_method: "btree",
      attributes: columns.map((column, position) => ({ column, position: position + 1 })),
      key_count: columns.length,
      predicate,
      primary: name.endsWith("_pkey"),
      unique,
      valid: true,
    },
  };
}

function constraint(name: string, ownerTable: string, signature: unknown): SchemaObject {
  return { kind: "constraint", name, owner_table: ownerTable, constraint_index: false, signature };
}

function completeBaseline(): SchemaObject[] {
  return [
    ...EXPECTED_CLEAN_LAUNCH_TABLES.map(table),
    ...EXPECTED_CLEAN_LAUNCH_TABLES.flatMap((name) => [
      { kind: "table_row_type", name, owner_table: name, constraint_index: false, signature: null },
      { kind: "table_row_array_type", name: `_${name}`, owner_table: name, constraint_index: false, signature: null },
    ]),
    ...EXPECTED_CLEAN_LAUNCH_SEQUENCES.map((name) => ({
      kind: "sequence", name, owner_table: null, constraint_index: false, signature: null,
    })),
    index("schema_migrations_pkey", "schema_migrations", ["version"], { constraint: true, unique: true }),
    constraint("schema_migrations_pkey", "schema_migrations", { columns: ["version"], type: "p" }),
    index("account_user_email_key", "account_user", ["email"], { constraint: true, unique: true }),
    constraint("account_user_email_key", "account_user", { columns: ["email"], type: "u" }),
    constraint("device_user_id_fkey", "device", {
      columns: ["user_id"], on_delete: "n", referenced_columns: ["user_id"],
      referenced_table: "account_user", type: "f",
    }),
    constraint("cloud_skill_plan_price_monthly_fen_check", "cloud_skill_plan", {
      columns: ["price_monthly_fen"], expression: "(price_monthly_fen >= 0)", type: "c", validated: true,
    }),
    index("idx_cloud_task_owner", "cloud_task", ["tenant_id", "device_id", "agent_id", "created_at"]),
  ];
}

function validate(objects: SchemaObject[], options: { phase: "bootstrap" | "baseline"; requireComplete?: boolean }) {
  return validatePublicSchemaObjects(objects, {
    ...options,
    expectedBaselineObjects: completeBaseline(),
  });
}

describe("clean-launch migration public schema boundary", () => {
  it("allows a truly empty first-run public schema", () => {
    expect(validatePublicSchemaObjects([], { phase: "bootstrap" })).toEqual({ tables: [], sequences: [] });
  });

  it("allows only schema_migrations and its canonical PostgreSQL-derived objects before the baseline", () => {
    const expected = completeBaseline();
    const objects = expected.filter((object) => object.name === "schema_migrations"
      || object.owner_table === "schema_migrations");
    expect(validate(objects, { phase: "bootstrap" }).tables).toEqual(["schema_migrations"]);
    expect(detectPublicSchemaPhase(objects)).toBe("bootstrap");
  });

  it("rejects a user-created index even when it targets schema_migrations during bootstrap", () => {
    expect(() => validate([
      table("schema_migrations"),
      index("idx_schema_migrations_extra", "schema_migrations", ["version"]),
    ], { phase: "bootstrap" })).toThrow(/index:idx_schema_migrations_extra on schema_migrations/u);
  });

  it.each([
    "view", "materialized_view", "foreign_table", "sequence", "function", "procedure",
    "domain", "enum", "composite_type", "custom_type", "extension", "trigger",
  ])("rejects an extra %s in an otherwise empty public schema", (kind) => {
    expect(() => validate([{ kind, name: "rogue_object" }], { phase: "bootstrap" }))
      .toThrow(new RegExp(`${kind}:rogue_object`, "u"));
  });

  it("accepts the exact canonical baseline catalog inventory", () => {
    const objects = completeBaseline();
    expect(detectPublicSchemaPhase(objects)).toBe("baseline");
    const result = validate(objects, { phase: "baseline", requireComplete: true });
    expect(result.tables).toEqual([...EXPECTED_CLEAN_LAUNCH_TABLES].sort());
    expect(result.sequences).toEqual([...EXPECTED_CLEAN_LAUNCH_SEQUENCES].sort());
  });

  it("rejects an arbitrary post-baseline index on an expected table", () => {
    expect(() => validate([
      ...completeBaseline(),
      index("idx_cloud_task_rogue", "cloud_task", ["status"]),
    ], { phase: "baseline", requireComplete: true })).toThrow(/index:idx_cloud_task_rogue on cloud_task/u);
  });

  it("detects a dropped critical UNIQUE constraint and its backing index", () => {
    const objects = completeBaseline().filter((object) => object.name !== "account_user_email_key");
    expect(() => validate(objects, { phase: "baseline", requireComplete: true }))
      .toThrow(/missing definitions: .*account_user_email_key/u);
  });

  it("detects altered CHECK and index definitions even when their names are unchanged", () => {
    const alteredCheck = completeBaseline().map((object) => object.name === "cloud_skill_plan_price_monthly_fen_check"
      ? { ...object, signature: { columns: ["price_monthly_fen"], expression: "(price_monthly_fen > 0)", type: "c", validated: true } }
      : object);
    expect(() => validate(alteredCheck, { phase: "baseline", requireComplete: true }))
      .toThrow(/altered public schema definitions: constraint:cloud_skill_plan_price_monthly_fen_check/u);

    const alteredIndex = completeBaseline().map((object) => object.name === "idx_cloud_task_owner"
      ? index("idx_cloud_task_owner", "cloud_task", ["status"])
      : object);
    expect(() => validate(alteredIndex, { phase: "baseline", requireComplete: true }))
      .toThrow(/altered public schema definitions: index:idx_cloud_task_owner/u);
  });

  it("detects a changed foreign-key action", () => {
    const objects = completeBaseline().map((object) => object.name === "device_user_id_fkey"
      ? constraint("device_user_id_fkey", "device", {
        columns: ["user_id"], on_delete: "c", referenced_columns: ["user_id"],
        referenced_table: "account_user", type: "f",
      })
      : object);
    expect(() => validate(objects, { phase: "baseline", requireComplete: true }))
      .toThrow(/altered public schema definitions: constraint:device_user_id_fkey/u);
  });

  it("rejects unexpected sequences and objects owned by unknown tables", () => {
    expect(() => validate([
      ...completeBaseline(),
      { kind: "sequence", name: "rogue_seq" },
      index("rogue_idx", "rogue_table", ["id"]),
    ], { phase: "baseline", requireComplete: true })).toThrow(/sequence:rogue_seq/u);
  });

  it("requires every expected table and sequence for a completed baseline", () => {
    expect(() => validate([table("schema_migrations")], {
      phase: "baseline",
      requireComplete: true,
    })).toThrow(/missing tables: account_user/u);

    const withoutRevisionSequence = completeBaseline().filter((object) => object.name !== "feature_policy_revision_seq");
    expect(() => validate(withoutRevisionSequence, {
      phase: "baseline",
      requireComplete: true,
    })).toThrow(/missing sequences: feature_policy_revision_seq/u);
  });

  it("reports only migrations executed during the current run", () => {
    expect(migrationRunSummary([], ["schema_migrations", "account_user"])).toEqual({
      applied: [],
      tables: ["schema_migrations", "account_user"],
    });
    expect(migrationRunSummary(["0001-clean-launch-baseline.sql"], ["schema_migrations"])).toEqual({
      applied: ["0001-clean-launch-baseline.sql"],
      tables: ["schema_migrations"],
    });
  });

  it("pins the complete clean-launch migration set independently of its SQL", () => {
    const pinned = PINNED_CLEAN_LAUNCH_MIGRATIONS.map((migration) => ({ ...migration }));
    expect(validatePinnedMigrationSet(pinned)).toEqual(pinned);

    expect(() => validatePinnedMigrationSet([
      { ...pinned[0], checksum: "0".repeat(64) },
    ])).toThrow(/pinned migration identity\/checksum mismatch/u);

    expect(() => validatePinnedMigrationSet([
      ...pinned,
      { version: "0002", name: "rogue", filename: "0002-rogue.sql", checksum: "1".repeat(64) },
    ])).toThrow(/pinned migration set mismatch; unexpected: 0002-rogue\.sql/u);

    expect(() => validatePinnedMigrationSet([]))
      .toThrow(/pinned migration set mismatch; missing: 0001-clean-launch-baseline\.sql/u);
  });
});
