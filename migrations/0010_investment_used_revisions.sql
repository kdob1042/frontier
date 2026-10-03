-- Retain only opaque revision IDs after source deletion, without article text or URLs.
CREATE TABLE investment_used_revisions (
 revision TEXT PRIMARY KEY,
 used_at TEXT NOT NULL
);
-- Existing successful runs also count as used. Failed runs do not.
INSERT OR IGNORE INTO investment_used_revisions(revision,used_at)
SELECT json_extract(ref.value,'$.revision'),j.updated_at
FROM investment_runs i JOIN jobs j ON j.id=i.job_id,json_each(i.snapshot_json) ref
WHERE j.status='completed' AND i.output_json IS NOT NULL;
