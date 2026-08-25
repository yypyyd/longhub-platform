-- Run manually after the clean-launch runner, for example:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infrastructure/migrations/clean-launch/smoke/schema-smoke.sql
-- The runner deliberately does not recurse into this directory.

\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE longhub_canonical_schema_seed(value integer) ON COMMIT DROP;
DROP TABLE pg_temp.longhub_canonical_schema_seed;
SET LOCAL search_path TO pg_temp;
\ir ../0001-clean-launch-baseline.sql
SET LOCAL search_path TO public;

DO $$
DECLARE
  forbidden_tables TEXT[] := ARRAY[
    'activation_code', 'entitlement', 'pack_release', 'pack_review', 'skill_release',
    'product', 'wallet_txn', 'knowledge_document'
  ];
  expected_tables TEXT[] := ARRAY[
    'schema_migrations',
    'account_user', 'auth_session', 'admin_account', 'audit_log', 'device', 'device_pairing_challenge',
    'cloud_task', 'cloud_task_event', 'cloud_skill_adapter_release', 'cloud_skill_plan',
    'cloud_skill_plan_skill', 'billing_order', 'cloud_skill_subscription', 'cloud_skill_entitlement',
    'cloud_agent_skill_binding', 'cloud_skill_execution_reservation', 'model_gateway_config',
    'feature_policy', 'client_telemetry_hourly', 'model_request_hourly', 'http_route_hourly',
    'feature_policy_emergency_observation', 'model_usage_aggregate', 'manager_release',
    'billing_settlement', 'billing_outbox'
  ];
  expected_sequences TEXT[] := ARRAY[
    'cloud_task_event_event_id_seq',
    'feature_policy_revision_seq'
  ];
  public_namespace OID;
  object_name TEXT;
  unexpected_objects TEXT;
  integrity_mismatch TEXT;
BEGIN
  SELECT namespace.oid
    INTO public_namespace
    FROM pg_catalog.pg_namespace namespace
   WHERE namespace.nspname = 'public';
  IF public_namespace IS NULL THEN
    RAISE EXCEPTION 'public schema is missing';
  END IF;

  FOREACH object_name IN ARRAY forbidden_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class class
       WHERE class.relnamespace = public_namespace
         AND class.relname = object_name
    ) THEN
      RAISE EXCEPTION 'forbidden clean-launch relation exists: %', object_name;
    END IF;
  END LOOP;

  FOREACH object_name IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class class
       WHERE class.relnamespace = public_namespace
         AND class.relkind = 'r'
         AND class.relname = object_name
    ) THEN
      RAISE EXCEPTION 'clean-launch table is missing: %', object_name;
    END IF;
  END LOOP;

  FOREACH object_name IN ARRAY expected_sequences LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class class
       WHERE class.relnamespace = public_namespace
         AND class.relkind = 'S'
         AND class.relname = object_name
    ) THEN
      RAISE EXCEPTION 'clean-launch sequence is missing: %', object_name;
    END IF;
  END LOOP;

  SELECT string_agg(unexpected.object_identity, ', ' ORDER BY unexpected.object_identity)
    INTO unexpected_objects
    FROM (
      SELECT format('relation[%s]:%I', class.relkind, class.relname) AS object_identity
        FROM pg_catalog.pg_class class
       WHERE class.relnamespace = public_namespace
         AND NOT (
           (class.relkind = 'r' AND class.relname = ANY(expected_tables))
           OR (class.relkind = 'S' AND class.relname = ANY(expected_sequences))
           OR (class.relkind = 'i' AND EXISTS (
             SELECT 1
               FROM pg_catalog.pg_index index_record
               JOIN pg_catalog.pg_class owner ON owner.oid = index_record.indrelid
              WHERE index_record.indexrelid = class.oid
                AND owner.relnamespace = public_namespace
                AND owner.relkind = 'r'
                AND owner.relname = ANY(expected_tables)
           ))
         )

      UNION ALL

      SELECT format('type[%s]:%I', type_record.typtype, type_record.typname)
        FROM pg_catalog.pg_type type_record
       WHERE type_record.typnamespace = public_namespace
         AND NOT (
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_class row_relation
              WHERE row_relation.oid = type_record.typrelid
                AND row_relation.relnamespace = public_namespace
                AND row_relation.relkind = 'r'
                AND row_relation.relname = ANY(expected_tables)
           )
           OR EXISTS (
             SELECT 1
               FROM pg_catalog.pg_type element_type
               JOIN pg_catalog.pg_class element_relation ON element_relation.oid = element_type.typrelid
              WHERE element_type.oid = type_record.typelem
                AND element_relation.relnamespace = public_namespace
                AND element_relation.relkind = 'r'
                AND element_relation.relname = ANY(expected_tables)
           )
         )

      UNION ALL
      SELECT format('routine:%I(%s)', procedure_record.proname, pg_catalog.pg_get_function_identity_arguments(procedure_record.oid))
        FROM pg_catalog.pg_proc procedure_record
       WHERE procedure_record.pronamespace = public_namespace
      UNION ALL
      SELECT format('collation:%I', record.collname) FROM pg_catalog.pg_collation record WHERE record.collnamespace = public_namespace
      UNION ALL
      SELECT format('conversion:%I', record.conname) FROM pg_catalog.pg_conversion record WHERE record.connamespace = public_namespace
      UNION ALL
      SELECT format('operator:%I', record.oprname) FROM pg_catalog.pg_operator record WHERE record.oprnamespace = public_namespace
      UNION ALL
      SELECT format('operator_class:%I', record.opcname) FROM pg_catalog.pg_opclass record WHERE record.opcnamespace = public_namespace
      UNION ALL
      SELECT format('operator_family:%I', record.opfname) FROM pg_catalog.pg_opfamily record WHERE record.opfnamespace = public_namespace
      UNION ALL
      SELECT format('text_search_configuration:%I', record.cfgname) FROM pg_catalog.pg_ts_config record WHERE record.cfgnamespace = public_namespace
      UNION ALL
      SELECT format('text_search_dictionary:%I', record.dictname) FROM pg_catalog.pg_ts_dict record WHERE record.dictnamespace = public_namespace
      UNION ALL
      SELECT format('text_search_parser:%I', record.prsname) FROM pg_catalog.pg_ts_parser record WHERE record.prsnamespace = public_namespace
      UNION ALL
      SELECT format('text_search_template:%I', record.tmplname) FROM pg_catalog.pg_ts_template record WHERE record.tmplnamespace = public_namespace
      UNION ALL
      SELECT format('extended_statistics:%I', record.stxname) FROM pg_catalog.pg_statistic_ext record WHERE record.stxnamespace = public_namespace
      UNION ALL
      SELECT format('extension:%I', record.extname) FROM pg_catalog.pg_extension record WHERE record.extnamespace = public_namespace
      UNION ALL
      SELECT format('row_security_policy:%I on %I', policy.polname, class.relname)
        FROM pg_catalog.pg_policy policy
        JOIN pg_catalog.pg_class class ON class.oid = policy.polrelid
       WHERE class.relnamespace = public_namespace
      UNION ALL
      SELECT format('trigger:%I on %I', trigger_record.tgname, class.relname)
        FROM pg_catalog.pg_trigger trigger_record
        JOIN pg_catalog.pg_class class ON class.oid = trigger_record.tgrelid
       WHERE class.relnamespace = public_namespace
         AND NOT trigger_record.tgisinternal
      UNION ALL
      SELECT format('rewrite_rule:%I on %I', rule.rulename, class.relname)
        FROM pg_catalog.pg_rewrite rule
        JOIN pg_catalog.pg_class class ON class.oid = rule.ev_class
       WHERE class.relnamespace = public_namespace
         AND rule.rulename <> '_RETURN'
      UNION ALL
      SELECT format('default_acl:%s:%s', pg_catalog.pg_get_userbyid(record.defaclrole), record.defaclobjtype)
        FROM pg_catalog.pg_default_acl record
       WHERE record.defaclnamespace = public_namespace
    ) unexpected;
  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected public schema objects: %', unexpected_objects;
  END IF;

  WITH integrity_objects AS (
    SELECT
      namespace.oid AS schema_oid,
      pg_catalog.jsonb_build_object(
        'kind', 'index',
        'name', class.relname,
        'owner_table', owner.relname,
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
      ) AS signature
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      JOIN pg_catalog.pg_index index_record ON index_record.indexrelid = class.oid
      JOIN pg_catalog.pg_class owner ON owner.oid = index_record.indrelid
      JOIN pg_catalog.pg_am access_method ON access_method.oid = class.relam
     WHERE namespace.oid IN (public_namespace, pg_catalog.pg_my_temp_schema())

    UNION ALL

    SELECT
      namespace.oid AS schema_oid,
      pg_catalog.jsonb_build_object(
        'kind', 'constraint',
        'name', constraint_record.conname,
        'owner_table', owner.relname,
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
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = owner.relnamespace
      LEFT JOIN pg_catalog.pg_class referenced ON referenced.oid = constraint_record.confrelid
     WHERE namespace.oid IN (public_namespace, pg_catalog.pg_my_temp_schema())
  ), differences AS (
    (SELECT 'unexpected/altered'::text AS direction, signature
       FROM integrity_objects WHERE schema_oid = public_namespace
     EXCEPT
     SELECT 'unexpected/altered'::text, signature
       FROM integrity_objects WHERE schema_oid = pg_catalog.pg_my_temp_schema())
    UNION ALL
    (SELECT 'missing'::text AS direction, signature
       FROM integrity_objects WHERE schema_oid = pg_catalog.pg_my_temp_schema()
     EXCEPT
     SELECT 'missing'::text, signature
       FROM integrity_objects WHERE schema_oid = public_namespace)
  )
  SELECT pg_catalog.string_agg(
           format('%s %s:%s on %s', direction, signature->>'kind', signature->>'name', signature->>'owner_table'),
           ', ' ORDER BY direction, signature->>'kind', signature->>'name', signature->>'owner_table'
         )
    INTO integrity_mismatch
    FROM differences;
  IF integrity_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'clean-launch constraint/index integrity mismatch: %', integrity_mismatch;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account_user' AND column_name = 'balance_fen') THEN
    RAISE EXCEPTION 'legacy column account_user.balance_fen exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device' AND column_name IN ('activation_code_id', 'activated_at')) THEN
    RAISE EXCEPTION 'legacy device activation columns exist';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device' AND column_name = 'device_token') THEN
    RAISE EXCEPTION 'clear device token column exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_order' AND column_name IN ('product_id', 'pack_id')) THEN
    RAISE EXCEPTION 'legacy billing_order resource columns exist';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'model_gateway_config' AND column_name IN ('assistant_name', 'assistant_avatar_path', 'welcome_message', 'quick_tasks', 'features')) THEN
    RAISE EXCEPTION 'legacy model UI columns exist';
  END IF;
END $$;

ROLLBACK;
SELECT 'clean-launch schema smoke: OK' AS result;
