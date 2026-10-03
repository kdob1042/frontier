ALTER TABLE sources ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN(0,1));
ALTER TABLE view_revisions ADD COLUMN proposal_id TEXT;
ALTER TABLE jobs ADD COLUMN view_context_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE view_proposals (
 id TEXT PRIMARY KEY, rendering_id TEXT NOT NULL REFERENCES renderings(id),
 root_id TEXT NOT NULL REFERENCES view_revisions(id), expected_revision TEXT NOT NULL,
 text TEXT NOT NULL, evidence_json TEXT NOT NULL
);
