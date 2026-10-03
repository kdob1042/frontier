CREATE TABLE listening_progress (
 rendering_id TEXT PRIMARY KEY REFERENCES renderings(id),
 chunk INTEGER NOT NULL CHECK(chunk>=0 AND chunk<=10000),
 updated_at INTEGER NOT NULL
);
