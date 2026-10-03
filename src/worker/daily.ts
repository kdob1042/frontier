import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { aiConfig, captureInputSchema, createJob, saveCapture } from './jobs';
import { ingestFeed, permittedPolicy, type Registry } from './feeds';
import { StoreError } from './storage';

export interface DailyParams {
  day: string;
}
export const jstDay = (timestamp = Date.now()) =>
  new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
const terminal = new Set(['completed', 'skipped', 'failed', 'budget_stopped']);
export async function startDaily(env: Env, day = jstDay(), resume = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day !== jstDay())
    throw new StoreError('current_day_required', 400);
  const id = `daily-${day}`,
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO daily_runs(day,run_id,status,stage,created_at,updated_at) VALUES(?,?,'queued','configuration',?,?) ON CONFLICT(day) DO NOTHING",
  )
    .bind(day, id, now, now)
    .run();
  const row = await env.DB.prepare('SELECT status FROM daily_runs WHERE day=?')
    .bind(day)
    .first<{ status: string }>();
  if (row?.status === 'completed' || (terminal.has(row?.status || '') && !resume))
    return { id, status: row?.status, duplicate: true };
  let instance;
  try {
    instance = await env.DAILY_WORKFLOW.get(id);
    await instance.status();
  } catch {
    try {
      instance = await env.DAILY_WORKFLOW.create({ id, params: { day } });
    } catch (error) {
      instance = await env.DAILY_WORKFLOW.get(id);
      try {
        await instance.status();
      } catch {
        throw error;
      }
    }
  }
  const state = await instance.status();
  if (
    resume &&
    ['errored', 'complete', 'terminated'].includes(state.status) &&
    row?.status !== 'completed'
  )
    await instance.restart();
  return { id, status: (await instance.status()).status, duplicate: false };
}
export async function selectDailyCandidates(db: D1Database, day: string) {
  const existing = (
    await db
      .prepare('SELECT candidate_id FROM daily_candidates WHERE day=? ORDER BY rank')
      .bind(day)
      .all<{ candidate_id: string }>()
  ).results;
  if (existing.length) return existing.map((r) => r.candidate_id);
  const rows = (
    await db
      .prepare(
        "SELECT c.id,c.registry_id,c.title_key,c.fingerprint,c.content_json FROM feed_candidates c JOIN source_registry r ON r.id=c.registry_id WHERE c.status='candidate' AND c.score>=2 AND r.enabled=1 AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.canonical_url=c.canonical_url AND (s.hidden=1 OR s.deleted_at IS NOT NULL)) AND c.published_at>=? AND c.published_at<=? ORDER BY c.published_at DESC,c.score DESC,c.id LIMIT 10",
      )
      .bind(
        new Date(Date.parse(`${day}T00:00:00+09:00`) - 14 * 86400000).toISOString(),
        new Date().toISOString(),
      )
      .all<{
        id: string;
        registry_id: string;
        title_key: string;
        fingerprint: string;
        content_json: string;
      }>()
  ).results;
  const selected: typeof rows = [],
    publishers = new Set<string>(),
    titles = new Set<string>(),
    originals = new Set<string>();
  // Source diversity and exact original/title dedup before paid work. No popularity-only ranking.
  for (const diversity of [true, false])
    for (const row of rows) {
      if (selected.length === 2) break;
      if (
        selected.some((r) => r.id === row.id) ||
        titles.has(row.title_key) ||
        originals.has(row.fingerprint) ||
        (diversity && publishers.has(row.registry_id))
      )
        continue;
      const registry = await db
        .prepare('SELECT * FROM source_registry WHERE id=?')
        .bind(row.registry_id)
        .first<Registry>();
      try {
        if (!registry) continue;
        const p = permittedPolicy(registry);
        if (!p.ai || !p.translate) continue;
        captureInputSchema.parse(JSON.parse(row.content_json));
      } catch {
        continue;
      }
      selected.push(row);
      publishers.add(row.registry_id);
      titles.add(row.title_key);
      originals.add(row.fingerprint);
    }
  const stmts = selected.map((r, i) =>
    db
      .prepare(
        'INSERT INTO daily_candidates(day,candidate_id,rank) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(day, r.id, i),
  );
  stmts.push(
    db
      .prepare(
        "UPDATE daily_runs SET selected_count=?,candidate_count=?,stage='translate',updated_at=? WHERE day=?",
      )
      .bind(selected.length, rows.length, new Date().toISOString(), day),
  );
  await db.batch(stmts);
  return (
    await db
      .prepare('SELECT candidate_id FROM daily_candidates WHERE day=? ORDER BY rank')
      .bind(day)
      .all<{ candidate_id: string }>()
  ).results.map((r) => r.candidate_id);
}
export async function prepareDailyJob(env: Env, candidateId: string) {
  const row = await env.DB.prepare('SELECT * FROM feed_candidates WHERE id=?')
    .bind(candidateId)
    .first<{
      registry_id: string;
      content_json: string | null;
      capture_id: string | null;
      job_id: string | null;
      status: string;
    }>();
  if (!row || !row.content_json || row.status === 'deleted')
    throw new StoreError('candidate_deleted', 400);
  const registry = await env.DB.prepare('SELECT * FROM source_registry WHERE id=?')
    .bind(row.registry_id)
    .first<Registry>();
  if (!registry) throw new StoreError('source_missing', 400);
  const p = permittedPolicy(registry);
  if (!p.ai || !p.translate) throw new StoreError('external_processing_not_permitted', 400);
  const input = captureInputSchema.parse(JSON.parse(row.content_json));
  const head = await env.DB.prepare(
    'SELECT current_revision,deleted_at,hidden FROM sources WHERE canonical_url=?',
  )
    .bind(input.source.url)
    .first<{ current_revision: string | null; deleted_at: string | null; hidden: number }>();
  if (head?.deleted_at) throw new StoreError('source_deleted');
  if (head?.hidden) throw new StoreError('source_hidden', 400);
  const saved = await saveCapture(env.DB, input);
  // Persist provenance before generation so every stage can recheck the current source policy.
  await env.DB.prepare(
    "UPDATE feed_candidates SET capture_id=?,status='translating' WHERE id=? AND status<>'deleted'",
  )
    .bind(saved.captureId, candidateId)
    .run();
  const job = await createJob(env, {
    captureId: saved.captureId,
    expectedRevision: head?.current_revision || null,
  });
  await env.DB.prepare("UPDATE feed_candidates SET job_id=? WHERE id=? AND status<>'deleted'")
    .bind(job.id, candidateId)
    .run();
  return job.id;
}
export async function syncDailyCandidate(db: D1Database, id: string) {
  const row = await db
    .prepare(
      'SELECT c.status,c.capture_id,j.status AS job_status,j.error_code FROM feed_candidates c LEFT JOIN jobs j ON j.id=c.job_id WHERE c.id=?',
    )
    .bind(id)
    .first<{
      status: string;
      capture_id: string;
      job_status: string | null;
      error_code: string | null;
    }>();
  if (!row || row.status === 'deleted') return 'deleted';
  if (row.job_status === 'completed') {
    const r = await db
      .prepare(
        'SELECT r.id FROM renderings r JOIN sources s ON s.current_revision=r.id AND s.deleted_at IS NULL WHERE r.capture_id=? ORDER BY r.created_at DESC LIMIT 1',
      )
      .bind(row.capture_id)
      .first<{ id: string }>();
    if (!r) return 'stale';
    await db
      .prepare(
        "UPDATE feed_candidates SET status='completed',rendering_id=?,reason='validated_japanese' WHERE id=? AND status<>'deleted'",
      )
      .bind(r.id, id)
      .run();
    return 'completed';
  }
  if (
    ['failed', 'submission_unknown', 'budget_stopped', 'source_deleted', 'cancelled'].includes(
      row.job_status || '',
    )
  ) {
    await db
      .prepare("UPDATE feed_candidates SET status=?,reason=? WHERE id=? AND status<>'deleted'")
      .bind(row.job_status, row.error_code || row.job_status, id)
      .run();
    return row.job_status!;
  }
  return 'pending';
}
export async function finishEdition(db: D1Database, day: string, runId: string) {
  const selected = (
    await db
      .prepare(
        `SELECT c.id,c.status,c.rendering_id,s.id AS source_id FROM daily_candidates d JOIN feed_candidates c ON c.id=d.candidate_id LEFT JOIN renderings r ON r.id=c.rendering_id LEFT JOIN captures cap ON cap.id=r.capture_id LEFT JOIN sources s ON s.id=cap.source_id AND s.current_revision=r.id AND s.deleted_at IS NULL AND s.hidden=0 WHERE d.day=? ORDER BY c.score DESC,d.rank`,
      )
      .bind(day)
      .all<{ id: string; status: string; rendering_id: string | null; source_id: string | null }>()
  ).results;
  const complete = selected.filter((c) => c.status === 'completed' && c.source_id);
  const pending = selected.some((c) => ['translating', 'candidate'].includes(c.status));
  const run = await db
    .prepare('SELECT source_results_json FROM daily_runs WHERE day=?')
    .bind(day)
    .first<{ source_results_json: string }>();
  const outcomes = Object.values(JSON.parse(run?.source_results_json || '{}'));
  const sourcesFailed = outcomes.length > 0 && outcomes.every((s) => s === 'failed');
  const status = complete.length
    ? 'completed'
    : pending
      ? 'awaiting'
      : selected.some((c) => c.status === 'budget_stopped')
        ? 'budget_stopped'
        : sourcesFailed || selected.some((c) => ['failed', 'submission_unknown'].includes(c.status))
          ? 'failed'
          : 'skipped';
  const reason = complete.length
    ? 'recommended_validated_scope'
    : pending
      ? 'translation_pending'
      : sourcesFailed
        ? 'source_fetch_failed'
        : selected.length
          ? 'no_validated_article'
          : 'no_sufficient_new_candidate';
  const now = new Date().toISOString();
  const best = complete[0];
  const statements: D1PreparedStatement[] = [];
  if (best)
    statements.push(
      db
        .prepare(
          `INSERT INTO editions(day,source_id,rendering_id,status,run_id,created_at) SELECT ?,?,?,'completed',?,? WHERE EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision=? AND deleted_at IS NULL) ON CONFLICT(day) DO NOTHING`,
        )
        .bind(
          day,
          best.source_id,
          best.rendering_id,
          runId,
          now,
          best.source_id,
          best.rendering_id,
        ),
    );
  statements.push(
    db
      .prepare(
        "UPDATE daily_runs SET status=?,stage='finished',reason=?,completed_count=?,updated_at=? WHERE day=? AND run_id=?",
      )
      .bind(status, reason, complete.length, now, day, runId),
  );
  await db.batch(statements);
  return { status, reason };
}
export class DailyWorkflow extends WorkflowEntrypoint<Env, DailyParams> {
  async run(event: WorkflowEvent<DailyParams>, step: WorkflowStep) {
    const { day } = event.payload,
      id = event.instanceId;
    const configured = await step.do('check daily configuration', async () => {
      let reason = '';
      if (this.env.DAILY_ENABLED !== 'true') reason = 'daily_disabled';
      else
        try {
          aiConfig(this.env);
        } catch {
          reason = 'ai_not_configured';
        }
      await this.env.DB.prepare(
        "UPDATE daily_runs SET status=?,stage='sources',reason=?,updated_at=? WHERE day=?",
      )
        .bind(reason ? 'skipped' : 'running', reason || null, new Date().toISOString(), day)
        .run();
      return !reason;
    });
    if (!configured) return { status: 'skipped' };
    const registries = await step.do('list permitted sources', async () => {
      const rows = (
        await this.env.DB.prepare(
          'SELECT * FROM source_registry WHERE enabled=1 ORDER BY id LIMIT 10',
        ).all<Registry>()
      ).results;
      return rows
        .filter((r) => {
          try {
            permittedPolicy(r);
            return true;
          } catch {
            return false;
          }
        })
        .map((r) => r.id);
    });
    const sourceResults: Record<string, string> = {};
    for (const source of registries) {
      sourceResults[source] = await step.do(
        `ingest ${source}`,
        { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
        async () => {
          if (this.env.DAILY_ENABLED !== 'true') return 'skipped';
          try {
            return (await ingestFeed(this.env.DB, source, fetch, new Date(), 2)).status;
          } catch {
            return 'failed';
          }
        },
      );
    }
    await step.do('save source outcomes', async () => {
      await this.env.DB.prepare(
        "UPDATE daily_runs SET source_results_json=?,stage='select' WHERE day=?",
      )
        .bind(JSON.stringify(sourceResults), day)
        .run();
      return true;
    });
    const chosen = await step.do('select at most two originals', () =>
      selectDailyCandidates(this.env.DB, day),
    );
    for (const candidate of chosen) {
      await step.do(
        `start ${candidate.slice(0, 16)}`,
        { retries: { limit: 0, delay: '1 second' } },
        async () => {
          try {
            if (this.env.DAILY_ENABLED !== 'true') throw new StoreError('daily_disabled', 400);
            await prepareDailyJob(this.env, candidate);
            return true;
          } catch (error) {
            await this.env.DB.prepare(
              "UPDATE feed_candidates SET status='failed',reason=? WHERE id=? AND status<>'deleted'",
            )
              .bind(error instanceof StoreError ? error.code : 'job_start_failed', candidate)
              .run();
            return false;
          }
        },
      );
    }
    for (let poll = 0; poll < 30 && chosen.length; poll++) {
      const pending = await step.do(`check translations ${poll}`, async () => {
        const states = [];
        for (const candidate of chosen)
          states.push(await syncDailyCandidate(this.env.DB, candidate));
        return states.some((s) => s === 'pending');
      });
      if (!pending) break;
      await step.sleep(`wait translations ${poll}`, '20 seconds');
    }
    return step.do('publish one immutable edition', () => finishEdition(this.env.DB, day, id));
  }
}
