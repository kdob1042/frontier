import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sqliteRuntime } from './sqlite-runtime';
import { demoBundle } from '../src/shared/demo';
import { feedFetch, register, rss } from './feed-fixtures';
import { deleteSource, getStory, importBundle, adoptDraft } from '../src/worker/storage';
import { saveCapture, loadCapture } from '../src/worker/jobs';
import { configureRegistry } from '../src/worker/feeds';

function checkpointStep(sleep: () => Promise<void> = async () => {}) {
  const checkpoints = new Map<string, unknown>();
  return {
    checkpoints,
    async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
      if (checkpoints.has(name)) return checkpoints.get(name);
      const fn = typeof options === 'function' ? options : callback;
      if (!fn) throw Error('callback_missing');
      const result = await fn();
      checkpoints.set(name, result);
      return result;
    },
    async sleep() {
      await sleep();
    },
  };
}
async function compiled() {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-daily-'));
  const stub = join(dir, 'cloudflare.mjs');
  await writeFile(stub, 'export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}');
  await build({
    stdin: {
      contents: "export * from './src/worker/daily'; export * from './src/worker/workflow';",
      resolveDir: process.cwd(),
    },
    outfile: join(dir, 'compiled.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { 'cloudflare:workers': stub },
    logLevel: 'silent',
  });
  return {
    module: await import(pathToFileURL(join(dir, 'compiled.mjs')).href),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
test('daily fixtures run permitted ingestion → two translations → grounded relation → one immutable JST edition; replay has no new inference', async () => {
  const { db, env, sqlite } = sqliteRuntime(),
    originalFetch = globalThis.fetch,
    code = await compiled();
  try {
    env.DAILY_ENABLED = 'true';
    await register(db);
    const prior = await importBundle(db, demoBundle);
    const existing = await getStory(db, demoBundle.slug);
    assert.ok(existing);
    await adoptDraft(db, existing.drafts[0].id, prior.revision);
    let calls = 0,
      created = 0;
    const children: Promise<unknown>[] = [],
      instances = new Map();
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.openai.com/v1/responses') return feedFetch(rss())(url, init);
      calls++;
      const payload = JSON.parse(init!.body as string),
        input = JSON.parse(payload.input);
      const generated = structuredClone(demoBundle.rendering);
      generated.title = `日次検証 ${calls}`;
      generated.paragraphs = input.paragraphs.map((p: { id: string; text: string }, i: number) => ({
        sourceId: p.id,
        text: demoBundle.rendering.paragraphs[i]?.text || '追加の製造実験。',
      }));
      if (input.peers.length)
        generated.relations = [
          {
            toRevision: input.peers[0].revision,
            fromClaim: 'c1',
            toClaim: input.peers[0].claims[0].id,
            kind: 'analogous_to',
            reason: '同じ工程学習の仕組みを比較する',
            conditions: '自作事例であり実媒体や独立検証ではない',
            fromEvidence: ['p1'],
            toEvidence: input.peers[0].claims[0].evidence,
          },
        ];
      return Response.json({
        id: `resp_daily_${calls}`,
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] },
        ],
        usage: { input_tokens: 100, output_tokens: 200 },
      });
    };
    env.HARVEST_WORKFLOW = {
      async get(id: string) {
        const found = instances.get(id);
        if (!found) throw Error('missing');
        return found;
      },
      async create({ id, params }: { id: string; params: unknown }) {
        created++;
        const instance = {
          state: 'running',
          async status() {
            return { status: this.state };
          },
        };
        instances.set(id, instance);
        const promise = new code.module.HarvestWorkflow({}, env)
          .run({ instanceId: id, payload: params }, checkpointStep())
          .then(
            () => {
              instance.state = 'complete';
            },
            () => {
              instance.state = 'errored';
            },
          );
        children.push(promise);
        return instance;
      },
    } as unknown as Env['HARVEST_WORKFLOW'];
    const day = code.module.jstDay(),
      id = `daily-${day}`,
      now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO daily_runs(day,run_id,status,stage,created_at,updated_at) VALUES(?,?,'queued','configuration',?,?)",
      )
      .bind(day, id, now, now)
      .run();
    const steps = checkpointStep(async () => {
      await Promise.all(children);
    });
    const workflow = new code.module.DailyWorkflow({}, env),
      event = { instanceId: id, payload: { day } };
    assert.equal((await workflow.run(event, steps)).status, 'completed');
    assert.equal(calls, 2);
    assert.equal(created, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM editions').get()!.n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM renderings').get()!.n, 3);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM relations').get()!.n, 2);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM view_revisions').get()!.n,
      1,
      'AI must never adopt or overwrite a user view',
    );
    await workflow.run(event, steps);
    assert.equal(calls, 2);
    // An explicit restart reconstructs state from D1 and reuses completed child jobs.
    await workflow.run(
      event,
      checkpointStep(async () => {
        await Promise.all(children);
      }),
    );
    assert.equal(calls, 2);
    assert.equal(created, 2);
    for (const value of steps.checkpoints.values())
      assert.ok(!JSON.stringify(value)?.includes(demoBundle.capture.paragraphs[0].text));
    const slug = sqlite
      .prepare('SELECT slug FROM sources WHERE canonical_url=?')
      .get('https://example.com/article-0')!.slug as string;
    const story = await getStory(db, slug);
    assert.ok(story);
    assert.equal(story.relations[0].kind, 'analogous_to');
    assert.equal(story.relations[0].independent, false);
    await deleteSource(db, demoBundle.slug, prior.revision);
    assert.equal(
      (await getStory(db, slug))!.relations.length,
      0,
      'deleted peer evidence cannot remain visible',
    );
    assert.equal(
      sqlite.prepare('SELECT evidence_missing FROM view_revisions').get()!.evidence_missing,
      1,
    );
    assert.equal(
      sqlite.prepare('SELECT SUM(actual_micro_usd) AS cost FROM jobs').get()!.cost,
      1000,
      'deletion does not reset spent cost',
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
    await code.dispose();
  }
});
test('AI-off daily run records a skip without fetching; current source revocation blocks already saved captures', async () => {
  const { db, env, sqlite } = sqliteRuntime(),
    code = await compiled(),
    originalFetch = globalThis.fetch;
  try {
    env.DAILY_ENABLED = 'true';
    env.AI_ENABLED = 'false';
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw Error('unexpected');
    };
    const day = code.module.jstDay(),
      id = `daily-${day}`,
      now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO daily_runs(day,run_id,status,stage,created_at,updated_at) VALUES(?,?,'queued','configuration',?,?)",
      )
      .bind(day, id, now, now)
      .run();
    assert.equal(
      (
        await new code.module.DailyWorkflow({}, env).run(
          { instanceId: id, payload: { day } },
          checkpointStep(),
        )
      ).status,
      'skipped',
    );
    assert.equal(calls, 0);
    await register(db);
    const raw = { slug: demoBundle.slug, source: demoBundle.source, capture: demoBundle.capture };
    const saved = await saveCapture(db, raw);
    await db
      .prepare(
        "INSERT INTO feed_candidates(id,registry_id,canonical_url,feed_id,title,published_at,updated_at,captured_at,discovered_day,fingerprint,title_key,content_json,status,reason,score,capture_id) VALUES('fixture-candidate','fixture',?,'guid','fixture',?,?,?,?,'fingerprint','title',?,'candidate','fixture',3,?)",
      )
      .bind(demoBundle.source.url, now, now, now, day, JSON.stringify(raw), saved.captureId)
      .run();
    await configureRegistry(db, 'fixture', {
      enabled: false,
      feedUrl: null,
      policy: null,
      reason: 'permission revoked',
    });
    await assert.rejects(() => loadCapture(db, saved.captureId), /disabled/);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
    await code.dispose();
  }
});
