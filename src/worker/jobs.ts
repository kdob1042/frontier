import { bundleSchema, type Bundle } from '../shared/model';
import { hash, StoreError } from './storage';

export const captureInputSchema = bundleSchema.omit({ rendering: true, processingVersion: true });
export type CaptureInput = ReturnType<typeof captureInputSchema.parse>;
export interface JobParams {
  captureId: string;
  expectedRevision: string | null;
}
export const processingVersion = 'harvest-v1';
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
      'SELECT c.*,s.slug FROM captures c JOIN sources s ON s.id=c.source_id WHERE c.id=? AND s.deleted_at IS NULL',
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
  return {
    slug: row.slug,
    source: JSON.parse(row.metadata_json),
    capture: {
      scope: row.scope,
      mode: row.mode,
      paragraphs: JSON.parse(row.paragraphs_json),
      permissions: JSON.parse(row.permissions_json),
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
    'INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(capture_id,processing_version) DO NOTHING',
  )
    .bind(id, params.captureId, version, 'queued', now, now)
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
    instance = await env.HARVEST_WORKFLOW.create({ id, params });
  }
  return { id, status: (await instance.status()).status, duplicate: false };
}
export async function reserveBudget(env: Env, jobId: string, reservation: number) {
  const config = aiConfig(env);
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }),
    month = day.slice(0, 7);
  const result = await env.DB.prepare(
    `UPDATE jobs SET status='reserved',reserved_micro_usd=?,budget_day=?,budget_month=?,updated_at=? WHERE id=? AND status='queued' AND (SELECT COALESCE(SUM(COALESCE(actual_micro_usd,reserved_micro_usd)),0) FROM jobs WHERE budget_day=?)+?<=? AND (SELECT COALESCE(SUM(COALESCE(actual_micro_usd,reserved_micro_usd)),0) FROM jobs WHERE budget_month=?)+?<=?`,
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
  await env.DB.prepare(
    "UPDATE jobs SET status='budget_stopped',error_code='budget_limit',updated_at=? WHERE id=? AND status='queued'",
  )
    .bind(new Date().toISOString(), jobId)
    .run();
  throw new StoreError('budget_stopped');
}
