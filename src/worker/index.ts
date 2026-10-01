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
} from './storage';
import { createJob, saveCapture } from './jobs';
export { HarvestWorkflow } from './workflow';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > 256000)
    throw new StoreError('input_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new StoreError('invalid_input', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 256000) {
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
app.get('/api/home', async (c) => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const edition = await c.env.DB.prepare(
    'SELECT s.slug,e.day,e.status FROM editions e LEFT JOIN sources s ON s.id=e.source_id AND s.deleted_at IS NULL ORDER BY e.day DESC LIMIT 1',
  ).first<{ slug: string | null; day: string; status: string }>();
  const rows = await listStories(c.env.DB);
  const recommended =
    (edition?.slug && rows.find((s) => s.slug === edition.slug)) ||
    rows.find((s) => s.mode !== 'link_only') ||
    rows[0] ||
    null;
  return c.json({
    recommended,
    recent: rows.filter((s) => s.slug !== recommended?.slug).slice(0, 3),
    day,
    edition: edition || null,
  });
});
app.get('/api/stories', async (c) =>
  c.json({ stories: await listStories(c.env.DB, c.req.query('q') || '') }),
);
app.get('/api/stories/:slug', async (c) => {
  const story = await getStory(c.env.DB, c.req.param('slug'));
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
app.post('/api/views/adopt', async (c) => {
  const p = z
    .object({ draftId: z.string().max(100), revision: z.string().max(100) })
    .strict()
    .parse(await body(c.req.raw));
  return c.json(await adoptDraft(c.env.DB, p.draftId, p.revision));
});
app.get('/api/views', async (c) =>
  c.json({
    views: (
      await c.env.DB.prepare(
        'SELECT v.id,v.text,v.created_at,v.evidence_missing,s.slug FROM view_revisions v JOIN sources s ON s.id=v.source_id ORDER BY v.created_at DESC LIMIT 100',
      ).all()
    ).results,
  }),
);
app.get('/api/export', async (c) => {
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
app.delete('/api/admin/stories/:slug', async (c) => {
  const rev = c.req.header('If-Match');
  if (!rev) return c.json({ error: 'revision_required' }, 400);
  await deleteSource(c.env.DB, c.req.param('slug'), rev === 'pending' ? null : rev);
  return c.json({ deleted: true });
});
app.get('/api/admin/status', async (c) =>
  c.json({
    environment: c.env.ENVIRONMENT,
    aiEnabled: c.env.AI_ENABLED === 'true',
    aiConfigured: !!c.env.OPENAI_MODEL,
    sources: (
      await c.env.DB.prepare(
        'SELECT id,name,homepage,enabled,reason,checked_at FROM source_registry ORDER BY name',
      ).all()
    ).results,
    jobs: (
      await c.env.DB.prepare(
        'SELECT id,status,error_code,input_tokens,output_tokens,reserved_micro_usd,actual_micro_usd,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 30',
      ).all()
    ).results,
  }),
);
app.get('/api/*', (c) => c.json({ error: 'not_found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
