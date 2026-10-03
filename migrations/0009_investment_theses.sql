CREATE TABLE investment_runs (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 snapshot_json TEXT NOT NULL,
 output_json TEXT
);
