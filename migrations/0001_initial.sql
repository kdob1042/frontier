PRAGMA foreign_keys = ON;
CREATE TABLE source_registry (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT NOT NULL, feed_url TEXT,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), policy_json TEXT NOT NULL,
 checked_at TEXT, reason TEXT NOT NULL
);
CREATE TABLE sources (
 id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, canonical_url TEXT NOT NULL UNIQUE,
 metadata_json TEXT NOT NULL, current_revision TEXT, deleted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE captures (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), scope TEXT NOT NULL,
 mode TEXT NOT NULL, paragraphs_json TEXT NOT NULL, permissions_json TEXT NOT NULL, metadata_json TEXT NOT NULL, captured_at TEXT NOT NULL
);
CREATE TABLE renderings (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), title TEXT NOT NULL,
 intro TEXT NOT NULL, paragraphs_json TEXT NOT NULL, processing_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE claims (
 id TEXT PRIMARY KEY, rendering_id TEXT NOT NULL REFERENCES renderings(id), local_id TEXT NOT NULL,
 text TEXT NOT NULL, kind TEXT NOT NULL, evidence_json TEXT NOT NULL, caveat TEXT NOT NULL
);
CREATE TABLE concepts (id TEXT PRIMARY KEY, name TEXT NOT NULL, meaning TEXT NOT NULL, UNIQUE(name, meaning));
CREATE TABLE rendering_concepts (rendering_id TEXT REFERENCES renderings(id), concept_id TEXT REFERENCES concepts(id), PRIMARY KEY(rendering_id, concept_id));
CREATE TABLE questions (id TEXT PRIMARY KEY, rendering_id TEXT REFERENCES renderings(id), text TEXT NOT NULL, evidence_json TEXT NOT NULL);
CREATE TABLE view_drafts (id TEXT PRIMARY KEY, rendering_id TEXT REFERENCES renderings(id), text TEXT NOT NULL, evidence_json TEXT NOT NULL);
CREATE TABLE view_revisions (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
 rendering_id TEXT NOT NULL, text TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
 evidence_missing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE reading_progress (source_id TEXT PRIMARY KEY REFERENCES sources(id), fraction REAL NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, processing_version TEXT NOT NULL,
 status TEXT NOT NULL, response_id TEXT, result_json TEXT, error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER, output_tokens INTEGER, reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
 actual_micro_usd INTEGER, budget_day TEXT, budget_month TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(capture_id, processing_version)
);
-- A failing CHECK rolls back the entire D1 batch before any stale/deleted capture is written.
CREATE TABLE write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE editions (day TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id), rendering_id TEXT, status TEXT NOT NULL);
CREATE INDEX captures_source ON captures(source_id);
CREATE INDEX renderings_capture ON renderings(capture_id);
CREATE INDEX claims_rendering ON claims(rendering_id);
