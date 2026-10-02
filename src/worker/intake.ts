import { z } from 'zod';
import { safeUrl } from '../shared/model';
import { mediaUploadSchema, MAX_MEDIA_BYTES, type MediaUpload } from '../shared/media';
import { permittedPolicy, type Registry, validatePublicUrl, readTextBounded } from './feeds';
import {
  parseArticle,
  parseCaptions,
  documentCapture,
  fetchPublic,
  type ArticleDocument,
} from './documents';
import { saveCapture, createJob, aiConfig, type CaptureInput } from './jobs';
import { StoreError } from './storage';

export async function intakePolicy(db: D1Database, id: string, url: string, kind?: string) {
  const row = await db
    .prepare('SELECT * FROM source_registry WHERE id=?')
    .bind(id)
    .first<Registry>();
  if (!row) throw new StoreError('not_found', 404);
  const p = permittedPolicy(row);
  validatePublicUrl(url, p.allowedHosts);
  if (kind === 'text' || kind === 'html') {
    if (!p.article) throw new StoreError('article_acquisition_not_permitted', 400);
  } else if (kind && !p.media?.includes(kind as 'image'))
    throw new StoreError('media_acquisition_not_permitted', 400);
  const source = await db
    .prepare('SELECT hidden,deleted_at FROM sources WHERE canonical_url=?')
    .bind(url)
    .first<{ hidden: number; deleted_at: string | null }>();
  if (source?.deleted_at || source?.hidden)
    throw new StoreError(source.deleted_at ? 'source_deleted' : 'source_hidden', 400);
  return { row, p };
}
export async function queueCapture(
  env: Env,
  capture: CaptureInput,
  expectedRevision: string | null = null,
) {
  const saved = await saveCapture(env.DB, capture);
  let configured = false;
  try {
    aiConfig(env);
    configured = true;
  } catch {}
  if (configured && capture.capture.permissions.ai && capture.capture.permissions.translate) {
    const job = await createJob(env, { captureId: saved.captureId, expectedRevision });
    return { ...saved, jobId: job.id, status: 'translating' };
  }
  return { ...saved, status: 'captured' };
}
export const intakeSchema = z
  .object({
    registryId: z.string().min(1).max(100),
    url: safeUrl,
    expectedRevision: z.string().length(64).nullable().default(null),
  })
  .strict();
export function documentKind(type: string) {
  const mime = type.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html') return 'html';
  if (mime === 'text/vtt' || mime === 'application/x-subrip') return 'captions';
  if (mime === 'text/plain') return 'text';
  if (['image/jpeg', 'image/png'].includes(mime)) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  throw new StoreError('document_type_not_supported', 400);
}
export async function intakeUrl(env: Env, input: unknown, request: typeof fetch = fetch) {
  const spec = intakeSchema.parse(input),
    { row, p } = await intakePolicy(env.DB, spec.registryId, spec.url);
  const { response, url } = await fetchPublic(spec.url, p, request);
  let kind: ReturnType<typeof documentKind>;
  try {
    kind = documentKind(response.headers.get('content-type') || '');
    await intakePolicy(env.DB, spec.registryId, url, kind);
  } catch (e) {
    await response.body?.cancel();
    throw e;
  }
  if (!['html', 'text', 'captions'].includes(kind)) {
    await response.body?.cancel();
    return {
      status: 'prepare_media',
      kind,
      url: spec.url,
      assetUrl: url,
      registryId: spec.registryId,
      expectedRevision: spec.expectedRevision,
    };
  }
  const text = await readTextBounded(response, 2_000_000);
  let paragraphs: CaptureInput['capture']['paragraphs'],
    metadata: Partial<CaptureInput['source']> = {};
  if (kind === 'html') {
    const article: ArticleDocument = parseArticle(text, url, p);
    paragraphs = article.paragraphs;
    metadata = {
      title: article.title,
      author: article.author,
      ...(article.publishedAt
        ? { publishedAt: article.publishedAt, publishedAtBasis: 'publisher' as const }
        : {}),
    };
    // A video-only article can supply a licensed subtitle track, or a direct video URL.
    if (paragraphs.map((p) => p.text).join(' ').length < 300) {
      if (article.captions.length && p.media?.includes('captions')) {
        const track = await fetchPublic(
          article.captions[0],
          p,
          request,
          'text/vtt,application/x-subrip',
        );
        if (
          !['captions', 'text'].includes(
            documentKind(track.response.headers.get('content-type') || ''),
          )
        ) {
          await track.response.body?.cancel();
          throw new StoreError('invalid_captions', 400);
        }
        paragraphs = parseCaptions(await readTextBounded(track.response, 256000), spec.url);
      } else {
        const candidate =
          article.videos.length && p.media?.includes('video')
            ? { kind: 'video', assetUrl: article.videos[0] }
            : article.audio.length && p.media?.includes('audio')
              ? { kind: 'audio', assetUrl: article.audio[0] }
              : article.images.length && p.media?.includes('image')
                ? { kind: 'image', assetUrl: article.images[0] }
                : null;
        if (candidate)
          return {
            status: 'prepare_media',
            ...candidate,
            url: spec.url,
            registryId: spec.registryId,
            expectedRevision: spec.expectedRevision,
          };
      }
    }
  } else if (kind === 'captions') paragraphs = parseCaptions(text, spec.url);
  else
    paragraphs = text
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, i) => ({
        id: `p${i + 1}`,
        text,
        origin: { kind: 'text', method: 'publisher_text', url: spec.url },
      }));
  return queueCapture(
    env,
    await documentCapture(row, p, spec.url, paragraphs, metadata),
    spec.expectedRevision,
  );
}
export async function intakeAsset(
  env: Env,
  id: string,
  url: string,
  request: typeof fetch = fetch,
) {
  const { p } = await intakePolicy(env.DB, id, url);
  const result = await fetchPublic(url, p, request);
  try {
    const kind = documentKind(result.response.headers.get('content-type') || '');
    if (!['image', 'audio', 'video', 'pdf'].includes(kind))
      throw new StoreError('document_type_not_supported', 400);
    await intakePolicy(env.DB, id, result.url, kind);
  } catch (e) {
    await result.response.body?.cancel();
    throw e;
  }
  // Read first to enforce the bound even when the origin omits Content-Length.
  const { readBytesBounded } = await import('./documents');
  return {
    bytes: await readBytesBounded(result.response, MAX_MEDIA_BYTES),
    mime: result.response.headers.get('content-type')!.split(';')[0],
  };
}
export function parseMediaUpload(input: unknown): MediaUpload {
  return mediaUploadSchema.parse(input);
}
