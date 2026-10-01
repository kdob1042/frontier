CREATE TABLE job_parts (
 job_id TEXT NOT NULL REFERENCES jobs(id), part INTEGER NOT NULL, kind TEXT NOT NULL,
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, response_id TEXT, result_json TEXT,
 input_tokens INTEGER, output_tokens INTEGER, actual_micro_usd INTEGER,
 PRIMARY KEY(job_id,part)
);
