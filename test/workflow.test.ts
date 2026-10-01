import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoBundle } from '../src/shared/demo';
import { hash, deleteSource, getStory } from '../src/worker/storage';
import { saveCapture, reserveBudget } from '../src/worker/jobs';
import { sqliteRuntime } from './sqlite-runtime';

test('durable checkpoints, funded generation, replay and deletion keep records and usage consistent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-workflow-test-'));
  const originalFetch = globalThis.fetch;
  const runtime = sqliteRuntime();
  try {
    const stub = join(dir, 'cloudflare.mjs');
    await writeFile(stub, 'export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}');
    await build({
      entryPoints: ['src/worker/workflow.ts'],
      outfile: join(dir, 'workflow.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'cloudflare:workers': stub },
      logLevel: 'silent',
    });
    const { HarvestWorkflow } = await import(pathToFileURL(join(dir, 'workflow.mjs')).href);
    const capture = await saveCapture(runtime.db, {
      slug: demoBundle.slug,
      source: demoBundle.source,
      capture: demoBundle.capture,
    });
    const id = await hash('workflow-fixture');
    const now = new Date().toISOString();
    await runtime.db
      .prepare(
        'INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(id, capture.captureId, 'fixture', 'queued', now, now)
      .run();
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      requests++;
      const payload = JSON.parse(init!.body as string);
      assert.equal('tools' in payload, false);
      return Response.json({
        id: 'resp_fixture',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(demoBundle.rendering) }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 200 },
      });
    };
    const checkpoints = new Map();
    const step = {
      async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
        if (checkpoints.has(name)) return checkpoints.get(name);
        const fn = typeof options === 'function' ? options : callback;
        if (!fn) throw new Error('missing callback');
        const value = await fn();
        checkpoints.set(name, value);
        return value;
      },
    };
    const workflow = new HarvestWorkflow({}, runtime.env);
    const event = {
      instanceId: id,
      payload: { captureId: capture.captureId, expectedRevision: null },
    };
    await workflow.run(event, step);
    assert.equal(requests, 1);
    const story = await getStory(runtime.db, demoBundle.slug);
    assert.ok(story);
    assert.equal(story.views.length, 0);
    assert.equal(story.rendering.claims.length, 2);
    assert.equal(
      runtime.sqlite.prepare('SELECT actual_micro_usd FROM jobs WHERE id=?').get(id)!
        .actual_micro_usd,
      500,
    );
    for (const value of checkpoints.values()) {
      const serialized = JSON.stringify(value) || '';
      assert.ok(!serialized.includes(demoBundle.capture.paragraphs[0].text));
      assert.ok(!serialized.includes(demoBundle.rendering.paragraphs[0].text));
    }
    await workflow.run(event, step);
    assert.equal(requests, 1, 'checkpoint replay must not call the provider twice');
    // Replaying the generation callback after its receipt was saved is safe even without a step checkpoint.
    checkpoints.delete('generate Japanese and grounded harvest');
    await workflow.run(event, step);
    assert.equal(requests, 1);
    await deleteSource(runtime.db, demoBundle.slug, story.revision);
    assert.equal(
      runtime.sqlite.prepare('SELECT actual_micro_usd,result_json FROM jobs WHERE id=?').get(id)!
        .actual_micro_usd,
      500,
    );
    assert.equal(
      runtime.sqlite.prepare('SELECT result_json FROM jobs WHERE id=?').get(id)!.result_json,
      null,
    );
    assert.equal(await getStory(runtime.db, demoBundle.slug), null);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('concurrent reservations obey daily/monthly caps and unknown submissions hold their cost', async () => {
  const { db, env, sqlite } = sqliteRuntime();
  try {
    const now = new Date().toISOString();
    for (const id of ['job1', 'job2', 'job3'])
      await db
        .prepare(
          'INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(id, id, id, 'queued', now, now)
        .run();
    env.DAILY_BUDGET_MICRO_USD = '150';
    env.MONTHLY_BUDGET_MICRO_USD = '150';
    const results = await Promise.allSettled([
      reserveBudget(env, 'job1', 100),
      reserveBudget(env, 'job2', 100),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = sqlite.prepare("SELECT id FROM jobs WHERE status='reserved'").get()!;
    await db
      .prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?")
      .bind(winner.id)
      .run();
    await assert.rejects(() => reserveBudget(env, 'job3', 100), /budget_stopped/);
  } finally {
    sqlite.close();
  }
});
