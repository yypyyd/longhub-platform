BEGIN;

ALTER TABLE model_gateway_config
  ADD COLUMN IF NOT EXISTS input_capabilities JSONB NOT NULL DEFAULT '["text"]'::jsonb;

ALTER TABLE model_gateway_config
  DROP CONSTRAINT IF EXISTS model_gateway_config_input_capabilities_check,
  ADD CONSTRAINT model_gateway_config_input_capabilities_check CHECK (
    input_capabilities = '["text"]'::jsonb OR input_capabilities = '["text", "image"]'::jsonb
  );

COMMIT;
