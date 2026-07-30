CREATE TABLE IF NOT EXISTS knowledge_document (
  document_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_label TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_document_tenant ON knowledge_document(tenant_id, created_at DESC);
