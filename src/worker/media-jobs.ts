import { Buffer } from 'node:buffer';
import { MAX_VIDEO_SECONDS, type MediaUpload } from '../shared/media';
import { hash, StoreError } from './storage';
import { aiConfig, reserveBudget, type CaptureInput } from './jobs';
import { intakePolicy } from './intake';
import { checkImage, wavSeconds } from './asset-format';

export interface StoredAsset {
  key: string;
  kind: MediaUpload['assets'][number]['kind'];
  mime: string;
  seconds?: number;
  duration?: number;
}
export interface MediaRecord {
  job_id: string;
  source_id: string;
  registry_id: string;
  policy_json: string;
  metadata_json: string | null;
  asset_keys_json: string;
}
export interface MediaMetadata {
  url: string;
  kind: MediaUpload['kind'];
  expectedRevision: string | null;
  source: CaptureInput['source'];
}
export function mediaConfig(env: Env, hasVision: boolean, hasAudio: boolean) {
  const c = aiConfig(env),
    visionBound = Number(env.VISION_INPUT_TOKEN_BOUND),
    audioRate = Number(env.AUDIO_MICRO_USD_PER_SECOND);
  if (
    hasVision &&
    (!Number.isSafeInteger(visionBound) || visionBound < 50000 || visionBound > 2000000)
  )
    throw new StoreError('vision_budget_not_configured', 400);
  if (hasAudio && (!Number.isFinite(audioRate) || audioRate <= 0))
    throw new StoreError('audio_rate_not_configured', 400);
  return { ...c, visionBound, audioRate };
}
export async function createMediaJob(env: Env, input: MediaUpload) {
  const { row, p } = await intakePolicy(env.DB, input.registryId, input.url, input.kind);
  if (!p.ai) throw new StoreError('external_processing_not_permitted', 400);
  const raw = input.assets.map((a) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data))
      throw new StoreError('invalid_media_data', 400);
    const bytes = new Uint8Array(Buffer.from(a.data, 'base64'));
    if (!bytes.length || bytes.length > (a.kind === 'audio' ? 5_760_044 : 2_000_000))
      throw new StoreError('asset_too_large', 400);
    const matches =
      a.kind === 'audio'
        ? a.mime === 'audio/wav'
        : a.kind === 'pdf'
          ? a.mime === 'application/pdf'
          : a.mime.startsWith('image/');
    if (!matches) throw new StoreError('asset_type_mismatch', 400);
    let duration: number | undefined;
    if (a.kind === 'audio') {
      duration = wavSeconds(bytes);
      if (duration > MAX_VIDEO_SECONDS) throw new StoreError('media_duration_limit', 400);
    } else if (a.kind === 'pdf') {
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
        throw new StoreError('invalid_pdf', 400);
    } else checkImage(bytes, a.mime);
    if (a.kind === 'frame' && a.seconds === undefined)
      throw new StoreError('frame_time_required', 400);
    return { bytes, kind: a.kind, mime: a.mime, seconds: a.seconds, duration };
  });
  const audio = raw.filter((a) => a.kind === 'audio'),
    vision = raw.filter((a) => a.kind !== 'audio');
  if (
    input.kind === 'video'
      ? audio.length !== 1 ||
        vision.length < 1 ||
        vision.some((a) => a.kind !== 'frame') ||
        vision.some((a) => a.seconds! > audio[0].duration!)
      : input.kind === 'audio'
        ? audio.length !== 1 || vision.length !== 0
        : input.kind === 'pdf'
          ? raw.length !== 1 || raw[0].kind !== 'pdf'
          : raw.length !== 1 || raw[0].kind !== 'image'
  )
    throw new StoreError('media_assets_incomplete', 400);
  mediaConfig(env, !!vision.length, !!audio.length);
  const sourceId = await hash(input.url),
    model = env.OPENAI_MODEL;
  const contentHash = await hash(
    await Promise.all(
      raw.map(async (a) => [
        Buffer.from(await crypto.subtle.digest('SHA-256', a.bytes)).toString('hex'),
        a.kind,
        a.seconds,
      ]),
    ),
  );
  const id = await hash([sourceId, contentHash, p, model, input.expectedRevision, 'media-v1']);
  const existing = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string }>();
  if (existing && existing.status !== 'queued')
    return { id, status: existing.status, duplicate: true };
  const now = new Date().toISOString(),
    source = {
      url: input.url,
      title: input.url,
      publisher: row.name,
      author: '著者表記なし',
      language: 'en',
      publishedAt: now,
      capturedAt: now,
      publishedAtBasis: 'capture_time' as const,
    };
  const metadata: MediaMetadata = {
    url: input.url,
    kind: input.kind,
    expectedRevision: input.expectedRevision,
    source,
  };
  const assets: StoredAsset[] = raw.map((a, i) => ({
    key: `media/${id}/${i}`,
    kind: a.kind,
    mime: a.mime,
    ...(a.seconds === undefined ? {} : { seconds: a.seconds }),
    ...(a.duration === undefined ? {} : { duration: a.duration }),
  }));
  const current = await env.DB.prepare('SELECT slug,current_revision FROM sources WHERE id=?')
    .bind(sourceId)
    .first<{ slug: string; current_revision: string | null }>();
  if ((current?.current_revision || null) !== input.expectedRevision)
    throw new StoreError('revision_conflict');
  const slug = current?.slug || `article-${(await hash(input.url)).slice(0, 24)}`,
    guard = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO sources(id,slug,canonical_url,metadata_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    ).bind(sourceId, slug, input.url, JSON.stringify(source), now),
    env.DB.prepare(
      'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE id=? AND deleted_at IS NULL AND hidden=0 AND current_revision IS ?)',
    ).bind(guard, sourceId, input.expectedRevision),
    env.DB.prepare(
      "INSERT INTO jobs(id,capture_id,processing_version,status,expected_revision,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?) ON CONFLICT DO NOTHING",
    ).bind(id, `media-${id}`, 'media-v1', input.expectedRevision, now, now),
    env.DB.prepare(
      'INSERT INTO media_requests(job_id,source_id,registry_id,policy_json,metadata_json,asset_keys_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    ).bind(
      id,
      sourceId,
      row.id,
      row.policy_json,
      JSON.stringify(metadata),
      JSON.stringify(assets),
      now,
    ),
    env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guard),
  ]);
  for (let i = 0; i < raw.length; i++)
    await env.MEDIA_BUCKET.put(assets[i].key, raw[i].bytes, {
      httpMetadata: { contentType: raw[i].mime },
    });
  await startMediaInstance(env, id);
  return { id, status: 'queued', duplicate: !!existing };
}
export async function startMediaInstance(env: Env, id: string) {
  try {
    const old = await env.MEDIA_WORKFLOW.get(id);
    await old.status();
  } catch (error) {
    try {
      await env.MEDIA_WORKFLOW.create({ id, params: { id } });
    } catch (createError) {
      const old = await env.MEDIA_WORKFLOW.get(id);
      try {
        await old.status();
      } catch {
        throw createError;
      }
    }
  }
}
export async function loadMedia(env: Env, id: string) {
  const row = await env.DB.prepare(
    'SELECT m.* FROM media_requests m JOIN sources s ON s.id=m.source_id WHERE m.job_id=? AND s.deleted_at IS NULL AND s.hidden=0',
  )
    .bind(id)
    .first<MediaRecord>();
  if (!row?.metadata_json) throw new StoreError('media_missing', 404);
  const metadata: MediaMetadata = JSON.parse(row.metadata_json),
    { p, row: registry } = await intakePolicy(env.DB, row.registry_id, metadata.url, metadata.kind);
  if (!p.ai || registry.policy_json !== row.policy_json)
    throw new StoreError('source_policy_changed', 400);
  return { row, metadata, p, registry, assets: JSON.parse(row.asset_keys_json) as StoredAsset[] };
}
export async function reserveMedia(env: Env, id: string) {
  const { assets } = await loadMedia(env, id),
    vision = assets.filter((a) => a.kind !== 'audio'),
    audio = assets.find((a) => a.kind === 'audio');
  const c = mediaConfig(env, !!vision.length, !!audio);
  const existing = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string }>();
  const reservation = Math.ceil(
    (vision.length
      ? c.visionBound * vision.length * c.inputRate + 6000 * c.outputRate + 16000 * c.inputRate
      : 0) + (audio ? Math.ceil(audio.duration!) * c.audioRate : 0),
  );
  if (!existing || !['reserved', 'sending', 'received', 'completed'].includes(existing.status))
    await reserveBudget(env, id, reservation);
  await env.DB.batch([
    ...(vision.length
      ? [
          env.DB.prepare(
            "INSERT INTO job_parts(job_id,part,kind,status) VALUES(?,0,'media_vision','queued') ON CONFLICT DO NOTHING",
          ).bind(id),
        ]
      : []),
    ...(audio
      ? [
          env.DB.prepare(
            "INSERT INTO job_parts(job_id,part,kind,status) VALUES(?,1,'media_audio','queued') ON CONFLICT DO NOTHING",
          ).bind(id),
        ]
      : []),
  ]);
  return { vision: !!vision.length, audio: !!audio };
}
export async function retryMediaJob(env: Env, id: string) {
  await loadMedia(env, id);
  const job = await env.DB.prepare('SELECT status,budget_day FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string; budget_day: string | null }>();
  if (!job || !['failed', 'budget_stopped', 'cancelled'].includes(job.status))
    throw new StoreError('job_not_retryable', 400);
  if (
    job.budget_day &&
    job.budget_day !== new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  )
    throw new StoreError('same_day_retry_required', 400);
  const parts = (
    await env.DB.prepare('SELECT status,attempts,actual_micro_usd FROM job_parts WHERE job_id=?')
      .bind(id)
      .all<{ status: string; attempts: number; actual_micro_usd: number | null }>()
  ).results;
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
    .bind(id, job.status)
    .run();
  await reserveMedia(env, id);
  await env.DB.prepare(
    "UPDATE job_parts SET status='queued' WHERE job_id=? AND status='failed' AND actual_micro_usd=0",
  )
    .bind(id)
    .run();
  await (await env.MEDIA_WORKFLOW.get(id)).restart();
  return { status: 'resuming_media' };
}
export async function removeMediaAssets(env: Env, sourceId: string) {
  const rows = (
    await env.DB.prepare(
      'SELECT asset_keys_json FROM media_requests WHERE source_id=? AND EXISTS(SELECT 1 FROM sources WHERE id=? AND deleted_at IS NOT NULL)',
    )
      .bind(sourceId, sourceId)
      .all<{ asset_keys_json: string }>()
  ).results;
  const keys = rows.flatMap((r) =>
    (JSON.parse(r.asset_keys_json) as StoredAsset[]).map((a) => a.key),
  );
  if (keys.length) await env.MEDIA_BUCKET.delete(keys);
  await env.DB.prepare(
    'UPDATE media_requests SET asset_keys_json=? WHERE source_id=? AND EXISTS(SELECT 1 FROM sources WHERE id=? AND deleted_at IS NOT NULL)',
  )
    .bind('[]', sourceId, sourceId)
    .run();
}
