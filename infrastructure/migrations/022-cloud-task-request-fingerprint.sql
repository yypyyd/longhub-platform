-- Bind an owner-scoped Cloud Task idempotency key to the complete normalized
-- request semantics. Historical rows cannot be reconstructed safely, so they
-- receive a sentinel and fail closed on all new replays.

ALTER TABLE cloud_task
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

UPDATE cloud_task
SET request_fingerprint = 'legacy-unbound'
WHERE request_fingerprint IS NULL;

ALTER TABLE cloud_task
  ALTER COLUMN request_fingerprint SET DEFAULT 'legacy-unbound',
  ALTER COLUMN request_fingerprint SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'cloud_task'::regclass
      AND conname = 'cloud_task_request_fingerprint_format'
  ) THEN
    ALTER TABLE cloud_task
      ADD CONSTRAINT cloud_task_request_fingerprint_format
      CHECK (
        request_fingerprint = 'legacy-unbound' OR
        request_fingerprint ~ '^v1:[a-f0-9]{64}$'
      )
      NOT VALID;
  END IF;
END $$;

ALTER TABLE cloud_task VALIDATE CONSTRAINT cloud_task_request_fingerprint_format;

COMMENT ON COLUMN cloud_task.request_fingerprint IS
  'Versioned private request binding; legacy-unbound denotes historical rows and is fail-closed';

