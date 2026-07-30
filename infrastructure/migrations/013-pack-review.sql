CREATE TABLE IF NOT EXISTS pack_review (
  review_id TEXT PRIMARY KEY, publisher TEXT NOT NULL, pack JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','rejected','approved','published')),
  findings JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
