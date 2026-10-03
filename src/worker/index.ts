import { investmentState, extractInvestment, importInvestment } from './investment';
import { makeSpeechPlan } from '../shared/speech';
import { Hono } from 'hono';
import { z } from 'zod';
import { authorize, validOrigin } from './auth';
import {
  adoptDraft,
  deleteSource,
  exportRecords,
  getStory,
  importBundle,
  listStories,
  StoreError,
  setVisibility,
} from './storage';
import { createJob, saveCapture, stopJob, retryJob, aiConfig } from './jobs';
import { startDaily } from './daily';
import { configureRegistry, ingestFeed } from './feeds';
import { listViews, editView, viewHistory, addNote, adoptProposal } from './views';
import { exportMarkdown } from './markdown';
import { intakeUrl, intakeAsset, parseMediaUpload } from './intake';
import { createMediaJob, retryMediaJob, removeMediaAssets } from './media-jobs';
export { HarvestWorkflow } from './workflow';
export { DailyWorkflow } from './daily';
export { MediaWorkflow } from './media-workflow';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (!(await authorize(c.req.raw, c.env)))
    return c.json({ error: 'authentication_required' }, 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !validOrigin(c.req.raw))
    return c.json({ error: 'invalid_origin' }, 403);
  await next();
});
app.onError((error, c) => {
  if (error instanceof StoreError)
    return c.json({ error: error.code }, error.status as 400 | 404 | 409);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: 'invalid_input' }, 400);
  // Private source content and credentials are not printed to Workers logs.
  return c.json({ error: 'operation_failed' }, 500);
});
async function body(request: Request, limit = 256000): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > limit)
    throw new StoreError('input_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new StoreError('invalid_input', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new StoreError('input_too_large', 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
app.post('/api/investment/import', async (c) =>
  c.json(await importInvestment(c.env, await body(c.req.raw))),
);
app.get('/api/investment', async (c) => c.json(await investmentState(c.env)));
app.post('/api/investment', async (c) =>
  c.json(await extractInvestment(c.env, await body(c.req.raw))),
);
app.get('/api/home', async (c) => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const edition = await c.env.DB.prepare(
    'SELECT s.slug,e.day,e.status,e.rendering_id FROM editions e LEFT JOIN sources s ON s.id=e.source_id AND s.deleted_at IS NULL ORDER BY e.day DESC LIMIT 1',
  ).first<{ slug: string | null; day: string; status: string; rendering_id: string }>();
  const rows = await listStories(c.env.DB);
  const pinned = edition?.slug
    ? await getStory(c.env.DB, edition.slug, edition.rendering_id)
    : null;
  const recommended =
    (pinned &&
      !pinned.hidden && {
        slug: pinned.slug,
        revision: pinned.revision,
        title: pinned.title,
        intro: pinned.intro,
        publisher: pinned.publisher,
        publishedAt: pinned.publishedAt,
        mode: pinned.mode,
        minutes: pinned.minutes,
        progress: pinned.currentRevision === pinned.revision ? pinned.progress : 0,
      }) ||
    rows.find((s) => s.mode !== 'link_only') ||
    rows[0] ||
    null;
  return c.json({
    recommended,
    recent: rows.filter((s) => s.slug !== recommended?.slug).slice(0, 3),
    day,
    edition: pinned && !pinned.hidden ? edition : null,
  });
});
app.get('/api/stories', async (c) =>
  c.json({ stories: await listStories(c.env.DB, c.req.query('q') || '') }),
);
app.get('/api/stories/:slug', async (c) => {
  const revision = c.req.query('revision');
  if (revision && !/^[a-f0-9]{64}$/.test(revision)) throw new StoreError('invalid_revision', 400);
  const story = await getStory(c.env.DB, c.req.param('slug'), revision);
  return story ? c.json(story) : c.json({ error: 'not_found' }, 404);
});
app.put('/api/stories/:slug/progress', async (c) => {
  const p = z
    .object({ fraction: z.number().min(0).max(1), updatedAt: z.number().int().nonnegative() })
    .strict()
    .parse(await body(c.req.raw));
  if (p.updatedAt > Date.now() + 60000) return c.json({ error: 'invalid_timestamp' }, 400);
  const result = await c.env.DB.prepare(
    `INSERT INTO reading_progress(source_id,fraction,updated_at) SELECT id,?,? FROM sources WHERE slug=? AND deleted_at IS NULL ON CONFLICT(source_id) DO UPDATE SET fraction=excluded.fraction,updated_at=excluded.updated_at WHERE excluded.updated_at>reading_progress.updated_at`,
  )
    .bind(p.fraction, p.updatedAt, c.req.param('slug'))
    .run();
  return c.json({ saved: !!result.meta.changes });
});
app.get('/api/stories/:slug/listening', async (c) => {
  const revision = c.req.query('revision');
  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw new StoreError('invalid_revision', 400);
  const story = await getStory(c.env.DB, c.req.param('slug'), revision);
  if (!story) throw new StoreError('not_found', 404);
  const progress = await c.env.DB.prepare(
    'SELECT chunk FROM listening_progress WHERE rendering_id=?',
  )
    .bind(revision)
    .first<{ chunk: number }>();
  return c.json({ chunk: progress?.chunk ?? 0 });
});
app.put('/api/stories/:slug/listening', async (c) => {
  const p = z
    .object({
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      chunk: z.number().int().min(0).max(10000),
      updatedAt: z.number().int().nonnegative(),
    })
    .strict()
    .parse(await body(c.req.raw));
  if (p.updatedAt > Date.now() + 60000) return c.json({ error: 'invalid_timestamp' }, 400);
  const story = await getStory(c.env.DB, c.req.param('slug'), p.revision);
  if (!story) throw new StoreError('not_found', 404);
  const plan = makeSpeechPlan(story);
  if (!plan.length || p.chunk > plan.length) throw new StoreError('invalid_input', 400);
  const result = await c.env.DB.prepare(
    `INSERT INTO listening_progress(rendering_id,chunk,updated_at)
     SELECT r.id,?,? FROM renderings r JOIN captures c ON c.id=r.capture_id
     JOIN sources s ON s.id=c.source_id WHERE s.slug=? AND s.deleted_at IS NULL AND r.id=?
     ON CONFLICT(rendering_id) DO UPDATE SET chunk=excluded.chunk,updated_at=excluded.updated_at
     WHERE excluded.updated_at>listening_progress.updated_at`,
  )
    .bind(p.chunk, p.updatedAt, story.slug, p.revision)
    .run();
  return c.json({ saved: !!result.meta.changes });
});
app.post('/api/views/adopt', async (c) => {
  const p = z
    .object({ draftId: z.string().max(100), revision: z.string().max(100) })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await adoptDraft(c.env.DB, p.draftId, p.revision));
});
app.get('/api/views', async (c) => c.json({ views: await listViews(c.env.DB) }));
app.get('/api/views/:root/history', async (c) =>
  c.json({ revisions: await viewHistory(c.env.DB, c.req.param('root')) }),
);
app.put('/api/views/:root', async (c) =>
  c.json(await editView(c.env.DB, c.req.param('root'), await body(c.req.raw))),
);
app.post('/api/stories/:slug/notes', async (c) =>
  c.json(await addNote(c.env.DB, c.req.param('slug'), await body(c.req.raw))),
);
app.post('/api/views/proposals/:id/adopt', async (c) => {
  const p = z
    .object({ revision: z.string().length(64) })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await adoptProposal(c.env.DB, c.req.param('id'), p.revision));
});
app.get('/api/export', async (c) => {
  if (c.req.query('format') === 'markdown') {
    c.header('Content-Disposition', 'attachment; filename="frontier-records.md"');
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(await exportMarkdown(c.env.DB));
  }
  c.header('Content-Disposition', 'attachment; filename="frontier-records.json"');
  return c.json(await exportRecords(c.env.DB));
});
app.post('/api/admin/import', async (c) => {
  try {
    return c.json(
      await importBundle(c.env.DB, await body(c.req.raw), c.req.header('If-Match') || null),
    );
  } catch (error) {
    if (error instanceof StoreError || error instanceof z.ZodError) throw error;
    throw new StoreError('invalid_record', 400);
  }
});
app.post('/api/admin/captures', async (c) =>
  c.json(await saveCapture(c.env.DB, await body(c.req.raw))),
);
app.post('/api/admin/jobs', async (c) => {
  const input = z
    .object({
      captureId: z.string().length(64),
      expectedRevision: z.string().length(64).nullable(),
    })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await createJob(c.env, input));
});
app.post('/api/admin/jobs/:id/stop', async (c) => c.json(await stopJob(c.env, c.req.param('id'))));
app.post('/api/admin/jobs/:id/retry', async (c) => {
  const media = await c.env.DB.prepare('SELECT job_id FROM media_requests WHERE job_id=?')
    .bind(c.req.param('id'))
    .first();
  return c.json(await (media ? retryMediaJob : retryJob)(c.env, c.req.param('id')));
});
app.delete('/api/admin/stories/:slug', async (c) => {
  const rev = c.req.header('If-Match');
  if (!rev) return c.json({ error: 'revision_required' }, 400);
  const source = await c.env.DB.prepare('SELECT id FROM sources WHERE slug=?')
    .bind(c.req.param('slug'))
    .first<{ id: string }>();
  await deleteSource(c.env.DB, c.req.param('slug'), rev === 'pending' ? null : rev);
  if (source) await removeMediaAssets(c.env, source.id);
  return c.json({ deleted: true });
});
app.put('/api/admin/stories/:slug/visibility', async (c) => {
  const p = z
    .object({ revision: z.string().length(64).nullable(), hidden: z.boolean() })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await setVisibility(c.env.DB, c.req.param('slug'), p.revision, p.hidden));
});
app.get('/api/admin/status', async (c) =>
  c.json({
    environment: c.env.ENVIRONMENT,
    aiEnabled: c.env.AI_ENABLED === 'true',
    aiConfigured: (() => {
      try {
        aiConfig(c.env);
        return true;
      } catch {
        return false;
      }
    })(),
    dailyEnabled: c.env.DAILY_ENABLED === 'true',
    dailyLimits: { candidates: 10, translations: 2, recommendations: 1 },
    records: (
      await c.env.DB.prepare(
        "SELECT s.slug,s.current_revision AS revision,s.hidden,COALESCE(r.title,json_extract(s.metadata_json,'$.title')) AS title FROM sources s LEFT JOIN renderings r ON r.id=s.current_revision WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 100",
      ).all()
    ).results,
    dailyRuns: (await c.env.DB.prepare('SELECT * FROM daily_runs ORDER BY day DESC LIMIT 14').all())
      .results,
    spending: (
      await c.env.DB.prepare(
        'SELECT budget_day,SUM(COALESCE(actual_micro_usd,reserved_micro_usd)) AS micro_usd FROM jobs GROUP BY budget_day ORDER BY budget_day DESC LIMIT 14',
      ).all()
    ).results,
    sources: (await c.env.DB.prepare('SELECT * FROM source_registry ORDER BY name').all()).results,
    jobs: (
      await c.env.DB.prepare(
        'SELECT id,status,error_code,input_tokens,output_tokens,reserved_micro_usd,actual_micro_usd,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 30',
      ).all()
    ).results,
  }),
);
app.put('/api/admin/sources/:id', async (c) =>
  c.json(await configureRegistry(c.env.DB, c.req.param('id'), await body(c.req.raw))),
);
app.post('/api/admin/sources/:id/ingest', async (c) =>
  c.json(await ingestFeed(c.env.DB, c.req.param('id'))),
);
app.post('/api/admin/daily', async (c) => {
  const p = z
    .object({ resume: z.boolean().default(false) })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await startDaily(c.env, undefined, p.resume));
});
app.post('/api/admin/intake', async (c) => c.json(await intakeUrl(c.env, await body(c.req.raw))));
app.get('/api/media/assets/:id/:index', async (c) => {
  const id = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(c.req.param('id'));
  const index = z.coerce.number().int().min(0).max(4).parse(c.req.param('index'));
  const record = await c.env.DB.prepare(
    'SELECT m.asset_keys_json FROM media_requests m JOIN sources s ON s.id=m.source_id WHERE m.job_id=? AND m.metadata_json IS NOT NULL AND s.deleted_at IS NULL',
  )
    .bind(id)
    .first<{ asset_keys_json: string }>();
  const asset =
    record && (JSON.parse(record.asset_keys_json) as Array<{ key: string; mime: string }>)[index];
  if (!asset) throw new StoreError('not_found', 404);
  const stored = await c.env.MEDIA_BUCKET.get(asset.key);
  if (!stored) throw new StoreError('not_found', 404);
  c.header('Content-Type', asset.mime);
  c.header('Content-Security-Policy', 'sandbox');
  return c.body(stored.body);
});
app.post('/api/admin/media', async (c) =>
  c.json(await createMediaJob(c.env, parseMediaUpload(await body(c.req.raw, 12_000_000)))),
);
app.get('/api/admin/intake/asset', async (c) => {
  const id = z.string().min(1).max(100).parse(c.req.query('registryId'));
  const url = z.string().url().max(2000).parse(c.req.query('url'));
  const asset = await intakeAsset(c.env, id, url);
  c.header('Content-Type', asset.mime);
  return c.body(asset.bytes);
});
app.get('/api/*', (c) => c.json({ error: 'not_found' }, 404));
app.all('*', async (c) => {
  if (
    c.env.ENVIRONMENT === 'production' &&
    (c.req.path === '/demo' || c.req.path.startsWith('/demo/'))
  )
    return c.redirect('/', 302);
  return c.env.ASSETS.fetch(c.req.raw);
});
export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    if (env.DAILY_ENABLED === 'true')
      await startDaily(
        env,
        new Date(event.scheduledTime).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }),
      );
  },
} satisfies ExportedHandler<Env>;
