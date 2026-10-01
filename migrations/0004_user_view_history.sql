ALTER TABLE view_revisions RENAME TO view_revisions_legacy;
CREATE TABLE view_revisions (
 id TEXT PRIMARY KEY, draft_id TEXT UNIQUE, source_id TEXT NOT NULL REFERENCES sources(id),
 rendering_id TEXT NOT NULL, text TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
 evidence_missing INTEGER NOT NULL DEFAULT 0, root_id TEXT NOT NULL, parent_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('adoption','edit','note'))
);
INSERT INTO view_revisions SELECT id,draft_id,source_id,rendering_id,text,evidence_json,created_at,evidence_missing,id,NULL,'adoption' FROM view_revisions_legacy;
DROP TABLE view_revisions_legacy;
CREATE TABLE view_heads (
 root_id TEXT PRIMARY KEY REFERENCES view_revisions(id),
 revision_id TEXT NOT NULL REFERENCES view_revisions(id)
);
INSERT INTO view_heads SELECT id,id FROM view_revisions;
CREATE INDEX views_root ON view_revisions(root_id);
