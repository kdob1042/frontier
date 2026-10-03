CREATE TABLE media_requests (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), source_id TEXT NOT NULL REFERENCES sources(id),
 registry_id TEXT NOT NULL REFERENCES source_registry(id), policy_json TEXT NOT NULL,
 metadata_json TEXT, asset_keys_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX media_requests_source ON media_requests(source_id);
