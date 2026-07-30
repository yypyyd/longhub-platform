-- 知识正文只允许保存 longhub-kb-v1 AES-256-GCM 信封。
-- VALIDATE 会在历史明文仍存在时失败；必须先按密钥轮换 Runbook 重新导入，禁止静默放行。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_document_content_encrypted'
      AND conrelid = 'knowledge_document'::regclass
  ) THEN
    ALTER TABLE knowledge_document
      ADD CONSTRAINT knowledge_document_content_encrypted
      CHECK (left(content, 14) = 'longhub-kb-v1:') NOT VALID;
  END IF;
END $$;

ALTER TABLE knowledge_document VALIDATE CONSTRAINT knowledge_document_content_encrypted;
