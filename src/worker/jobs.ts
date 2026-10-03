import { bundleSchema, type Bundle } from '../shared/model';
import { hash, StoreError } from './storage';
import { externalSourceStillPermitted, permittedPolicy, type Registry } from './feeds';

export const captureInputSchema = bundleSchema.omit({ rendering: true, processingVersion: true });
export type CaptureInput = ReturnType<typeof captureInputSchema.parse>;
export interface JobParams {
  captureId: string;
  expectedRevision: string | null;
}
export const processingVersion = 'harvest-v4';
export async function saveCapture(db: D1Database, input: unknown) {
  const b = captureInputSchema.parse(input);
  if (
    !b.capture.permissions.store ||
    !b.capture.paragraphs.length ||
    b.capture.mode === 'link_only'
  )
    throw new StoreError('capture_not_processable', 400);
  if (new Set(b.capture.paragraphs.map((p) => p.id)).size !== b.capture.paragraphs.length)
    throw new StoreError('duplicate_paragraph', 400);
  if (new TextEncoder().encode(JSON.stringify(b)).length > 32000)
    throw new StoreError('capture_too_large_split_required', 400);
  const sourceId = await hash(b.source.url);
  const id = await hash([
    sourceId,
    b.capture,
    b.source.title,
    b.source.publisher,
    b.source.author,
    b.source.publishedAt,
  ]);
  const existing = (
    await db
      .prepare('SELECT id,slug,deleted_at FROM sources WHERE canonical_url=? OR slug=? OR id=?')
      .bind(b.source.url, b.slug, sourceId)
      .all<{ id: string; slug: string; deleted_at: string | null }>()
  ).results;
  if (existing.some((s) => s.deleted_at)) throw new StoreError('source_deleted');
  if (existing.some((s) => s.id !== sourceId || s.slug !== b.slug))
    throw new StoreError('url_or_slug_conflict');
  const guardId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        'INSERT INTO sources(id,slug,canonical_url,metadata_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(sourceId, b.slug, b.source.url, JSON.stringify(b.source), new Date().toISOString()),
    db
      .prepare(
        'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE id=? AND deleted_at IS NULL)',
      )
      .bind(guardId, sourceId),
    db
      .prepare(
        'INSERT INTO captures(id,source_id,scope,mode,paragraphs_json,permissions_json,metadata_json,captured_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        id,
        sourceId,
        b.capture.scope,
        b.capture.mode,
        JSON.stringify(b.capture.paragraphs),
        JSON.stringify(b.capture.permissions),
        JSON.stringify(b.source),
        b.source.capturedAt,
      ),
    db.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ]);
  return { captureId: id, slug: b.slug };
}
export async function loadCapture(db: D1Database, id: string): Promise<CaptureInput> {
  const row = await db
    .prepare(
      'SELECT c.*,s.slug FROM captures c JOIN sources s ON s.id=c.source_id WHERE c.id=? AND s.deleted_at IS NULL AND s.hidden=0',
    )
    .bind(id)
    .first<{
      slug: string;
      metadata_json: string;
      scope: string;
      mode: Bundle['capture']['mode'];
      paragraphs_json: string;
      permissions_json: string;
    }>();
  if (!row) throw new StoreError('capture_missing', 404);
  await externalSourceStillPermitted(db, JSON.parse(row.metadata_json).url);
  const permissions = JSON.parse(row.permissions_json);
  if (permissions.registryId) {
    const registry = await db
      .prepare('SELECT * FROM source_registry WHERE id=?')
      .bind(permissions.registryId)
      .first<Registry>();
    if (!registry || (await hash(registry.policy_json)) !== permissions.policyHash)
      throw new StoreError('source_policy_changed', 400);
    const p = permittedPolicy(registry);
    if (!p.ai || !p.translate) throw new StoreError('source_policy_changed', 400);
  }
  return {
    slug: row.slug,
    source: JSON.parse(row.metadata_json),
    capture: {
      scope: row.scope,
      mode: row.mode,
      paragraphs: JSON.parse(row.paragraphs_json),
      permissions,
    },
  };
}
export function aiConfig(env: Env) {
  const daily = Number(env.DAILY_BUDGET_MICRO_USD),
    monthly = Number(env.MONTHLY_BUDGET_MICRO_USD),
    inputRate = Number(env.INPUT_MICRO_USD_PER_TOKEN),
    outputRate = Number(env.OUTPUT_MICRO_USD_PER_TOKEN);
  if (
    env.AI_ENABLED !== 'true' ||
    !env.OPENAI_API_KEY ||
    !env.OPENAI_MODEL ||
    ![daily, monthly, inputRate, outputRate].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new StoreError('ai_not_configured', 400);
  return { daily, monthly, inputRate, outputRate };
}
export async function createJob(env: Env, params: JobParams) {
  aiConfig(env);
  const b = await loadCapture(env.DB, params.captureId);
  if (!b.capture.permissions.ai || !b.capture.permissions.translate)
    throw new StoreError('external_processing_not_permitted', 400);
  const head = await env.DB.prepare(
    'SELECT current_revision FROM sources WHERE slug=? AND deleted_at IS NULL',
  )
    .bind(b.slug)
    .first<{ current_revision: string | null }>();
  if (head?.current_revision !== params.expectedRevision) throw new StoreError('revision_conflict');
  const version = `${processingVersion}-${await hash(env.OPENAI_MODEL)}`;
  const id = await hash([params.captureId, version]);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at,expected_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(capture_id,processing_version) DO NOTHING',
  )
    .bind(id, params.captureId, version, 'queued', now, now, params.expectedRevision)
    .run();
  const job = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string }>();
  if (job?.status !== 'queued') return { id, status: job?.status, duplicate: true };
  // An existing workflow instance is reused rather than triggering another charged call.
  let instance;
  try {
    instance = await env.HARVEST_WORKFLOW.get(id);
    await instance.status();
  } catch {
    try {
      instance = await env.HARVEST_WORKFLOW.create({ id, params });
    } catch (error) {
      instance = await env.HARVEST_WORKFLOW.get(id);
      try {
        await instance.status();
      } catch {
        throw error;
      }
    }
  }
  return { id, status: (await instance.status()).status, duplicate: false };
}
export async function reserveBudget(env: Env, jobId: string, reservation: number) {
  const config = aiConfig(env);
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }),
    month = day.slice(0, 7);
  const result = await env.DB.prepare(
    `UPDATE jobs SET status='reserved',actual_micro_usd=NULL,reserved_micro_usd=?,budget_day=?,budget_month=?,updated_at=? WHERE id=? AND status='queued' AND (SELECT COUNT(*) FROM jobs WHERE status IN('reserved','sending','submission_unknown'))<2 AND (SELECT COALESCE(SUM(COALESCE(actual_micro_usd,reserved_micro_usd)),0) FROM jobs WHERE budget_day=?)+?<=? AND (SELECT COALESCE(SUM(COALESCE(actual_micro_usd,reserved_micro_usd)),0) FROM jobs WHERE budget_month=?)+?<=?`,
  )
    .bind(
      reservation,
      day,
      month,
      new Date().toISOString(),
      jobId,
      day,
      reservation,
      config.daily,
      month,
      reservation,
      config.monthly,
    )
    .run();
  if (result.meta.changes) return;
  const job = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(jobId)
    .first<{ status: string }>();
  if (job?.status === 'reserved') return;
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status IN('reserved','sending','submission_unknown')",
  ).first<{ n: number }>();
  const code = (active?.n || 0) >= 2 ? 'concurrency_limit' : 'budget_limit';
  await env.DB.prepare(
    "UPDATE jobs SET status='budget_stopped',error_code=?,updated_at=? WHERE id=? AND status='queued'",
  )
    .bind(code, new Date().toISOString(), jobId)
    .run();
  throw new StoreError('budget_stopped');
}
export async function stopJob(env: Env, id: string) {
  await env.DB.prepare(
    "UPDATE jobs SET status=CASE WHEN status='sending' THEN 'submission_unknown' ELSE 'cancelled' END,error_code='owner_stopped',actual_micro_usd=CASE WHEN status IN('queued','reserved') THEN 0 ELSE actual_micro_usd END,updated_at=? WHERE id=? AND status IN('queued','reserved','sending','received')",
  )
    .bind(new Date().toISOString(), id)
    .run();
  const row = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string }>();
  if (!row) throw new StoreError('not_found', 404);
  try {
    const media = await env.DB.prepare('SELECT job_id FROM media_requests WHERE job_id=?')
      .bind(id)
      .first();
    const instance = await (media ? env.MEDIA_WORKFLOW : env.HARVEST_WORKFLOW).get(id);
    const state = await instance.status();
    if (['queued', 'running', 'waiting', 'paused'].includes(state.status))
      await instance.terminate();
  } catch {
    /* D1 cancellation still blocks all future submissions. */
  }
  return { status: row.status };
}
export async function retryJob(env: Env, id: string) {
  if (await env.DB.prepare('SELECT job_id FROM investment_runs WHERE job_id=?').bind(id).first())
    throw new StoreError('investment_retry_requires_new_confirmation', 400);
  aiConfig(env);
  const row = await env.DB.prepare(
    'SELECT capture_id,status,result_json,reserved_micro_usd,actual_micro_usd,attempts,expected_revision,budget_day FROM jobs WHERE id=?',
  )
    .bind(id)
    .first<{
      capture_id: string;
      status: string;
      result_json: string | null;
      reserved_micro_usd: number;
      actual_micro_usd: number | null;
      attempts: number;
      expected_revision: string | null;
      budget_day: string | null;
    }>();
  if (!row) throw new StoreError('not_found', 404);
  if (!['failed', 'budget_stopped', 'cancelled'].includes(row.status))
    throw new StoreError('job_not_retryable', 400);
  const capture = await loadCapture(env.DB, row.capture_id);
  const head = await env.DB.prepare(
    'SELECT current_revision FROM sources WHERE canonical_url=? AND deleted_at IS NULL',
  )
    .bind(capture.source.url)
    .first<{ current_revision: string | null }>();
  if (head?.current_revision !== row.expected_revision) throw new StoreError('revision_conflict');
  if (row.result_json) {
    await env.DB.prepare(
      "UPDATE jobs SET status='received',error_code=NULL WHERE id=? AND status=?",
    )
      .bind(id, row.status)
      .run();
    const instance = await env.HARVEST_WORKFLOW.get(id);
    await instance.restart({ from: { name: 'validate and commit immutable rendering' } });
    return { status: 'validating_saved_result' };
  }
  const parts = (
    await env.DB.prepare('SELECT status,attempts,actual_micro_usd FROM job_parts WHERE job_id=?')
      .bind(id)
      .all<{ status: string; attempts: number; actual_micro_usd: number | null }>()
  ).results;
  if (parts.length) {
    if (row.budget_day !== new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }))
      throw new StoreError('same_day_retry_required', 400);
    if (
      parts.some(
        (p) =>
          ['sending', 'submission_unknown'].includes(p.status) ||
          (p.status === 'received' && p.actual_micro_usd === null),
      )
    )
      throw new StoreError('submission_unknown_do_not_retry', 400);
    if (parts.some((p) => p.status !== 'received' && p.attempts >= 3))
      throw new StoreError('retry_limit', 400);
    await env.DB.prepare("UPDATE jobs SET status='queued',error_code=NULL WHERE id=? AND status=?")
      .bind(id, row.status)
      .run();
    await reserveBudget(env, id, row.reserved_micro_usd);
    await env.DB.prepare(
      "UPDATE job_parts SET status='queued' WHERE job_id=? AND status='failed' AND actual_micro_usd=0",
    )
      .bind(id)
      .run();
    const instance = await env.HARVEST_WORKFLOW.get(id);
    await instance.restart();
    return { status: 'resuming_saved_parts' };
  }
  if (row.attempts >= 3) throw new StoreError('retry_limit', 400);
  if (row.actual_micro_usd !== 0 && row.reserved_micro_usd > 0)
    throw new StoreError('submission_unknown_do_not_retry', 400);
  const updated = await env.DB.prepare(
    "UPDATE jobs SET status='queued',error_code=NULL,actual_micro_usd=NULL,reserved_micro_usd=0,budget_day=NULL,budget_month=NULL,updated_at=? WHERE id=? AND status=?",
  )
    .bind(new Date().toISOString(), id, row.status)
    .run();
  if (!updated.meta.changes) throw new StoreError('revision_conflict');
  const instance = await env.HARVEST_WORKFLOW.get(id);
  await instance.restart();
  return { status: 'queued' };
}
