ALTER TABLE source_registry ADD COLUMN last_attempt_at TEXT;
ALTER TABLE source_registry ADD COLUMN etag TEXT;
ALTER TABLE source_registry ADD COLUMN last_modified TEXT;
ALTER TABLE source_registry ADD COLUMN last_success_at TEXT;
ALTER TABLE source_registry ADD COLUMN error_code TEXT;
CREATE TABLE feed_candidates (
 id TEXT PRIMARY KEY, registry_id TEXT NOT NULL REFERENCES source_registry(id),
 canonical_url TEXT NOT NULL, feed_id TEXT NOT NULL, title TEXT NOT NULL,
 published_at TEXT NOT NULL, updated_at TEXT NOT NULL, captured_at TEXT NOT NULL, discovered_day TEXT NOT NULL,
 fingerprint TEXT NOT NULL, title_key TEXT NOT NULL, content_json TEXT,
 status TEXT NOT NULL, reason TEXT NOT NULL, score INTEGER NOT NULL,
 capture_id TEXT, job_id TEXT, rendering_id TEXT,
 UNIQUE(registry_id,canonical_url,fingerprint)
);
CREATE INDEX candidates_fingerprint ON feed_candidates(fingerprint);
CREATE INDEX candidates_url ON feed_candidates(canonical_url);
CREATE TABLE daily_runs (
 day TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
 stage TEXT NOT NULL, reason TEXT, candidate_count INTEGER NOT NULL DEFAULT 0,
 selected_count INTEGER NOT NULL DEFAULT 0, completed_count INTEGER NOT NULL DEFAULT 0,
 source_results_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE daily_candidates (
 day TEXT NOT NULL REFERENCES daily_runs(day), candidate_id TEXT NOT NULL REFERENCES feed_candidates(id),
 rank INTEGER NOT NULL, PRIMARY KEY(day,candidate_id), UNIQUE(day,rank)
);
ALTER TABLE editions ADD COLUMN run_id TEXT;
ALTER TABLE editions ADD COLUMN created_at TEXT;
ALTER TABLE jobs ADD COLUMN peer_revisions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN expected_revision TEXT;
CREATE TABLE relations (
 id TEXT PRIMARY KEY, from_revision TEXT NOT NULL REFERENCES renderings(id) ON DELETE CASCADE,
 to_revision TEXT NOT NULL REFERENCES renderings(id) ON DELETE CASCADE,
 from_claim TEXT NOT NULL, to_claim TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('supports','challenges','qualifies','analogous_to')),
 reason TEXT NOT NULL, conditions TEXT NOT NULL,
 from_evidence_json TEXT NOT NULL, to_evidence_json TEXT NOT NULL,
 independent INTEGER NOT NULL CHECK(independent IN(0,1)), created_at TEXT NOT NULL
);
CREATE INDEX relations_from ON relations(from_revision);
