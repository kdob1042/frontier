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

test('429 has at most three submissions; timeout, malformed output and stop do not cause a second charged request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-failures-')),
    originalFetch = globalThis.fetch;
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
    const { stopJob } = await import('../src/worker/jobs');
    for (const scenario of [
      '429-success',
      '429-exhausted',
      'timeout',
      'invalid-json',
      'stop',
      'budget',
    ]) {
      const { db, env, sqlite } = sqliteRuntime();
      let requests = 0;
      try {
        const capture = await saveCapture(db, {
          slug: demoBundle.slug,
          source: demoBundle.source,
          capture: demoBundle.capture,
        });
        const id = await hash(scenario),
          now = new Date().toISOString();
        await db
          .prepare(
            "INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)",
          )
          .bind(id, capture.captureId, scenario, now, now)
          .run();
        if (scenario === 'budget') env.DAILY_BUDGET_MICRO_USD = '1';
        globalThis.fetch = async () => {
          requests++;
          if (scenario.startsWith('429') && (scenario === '429-exhausted' || requests < 3))
            return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
          if (scenario === 'timeout') throw Error('network timeout');
          if (scenario === 'stop') await stopJob(env, id);
          return Response.json({
            id: 'resp_failure_fixture',
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text:
                      scenario === 'invalid-json'
                        ? 'not json'
                        : JSON.stringify(demoBundle.rendering),
                  },
                ],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 200 },
          });
        };
        const step = {
          async do(_name: string, options: unknown, callback?: () => Promise<unknown>) {
            const fn = typeof options === 'function' ? options : callback;
            if (!fn) throw Error('callback');
            const limit =
              typeof options === 'object'
                ? (options as { retries?: { limit: number } }).retries?.limit || 0
                : 0;
            for (let attempt = 0; ; attempt++) {
              try {
                return await fn();
              } catch (e) {
                if (attempt >= limit) throw e;
              }
            }
          },
        };
        const run = new HarvestWorkflow({}, env).run(
          { instanceId: id, payload: { captureId: capture.captureId, expectedRevision: null } },
          step,
        );
        if (scenario === '429-success') await run;
        else await assert.rejects(() => run);
        const job = sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(id)!;
        assert.equal(
          requests,
          scenario.startsWith('429') ? 3 : scenario === 'budget' ? 0 : 1,
          scenario,
        );
        if (scenario === '429-success') {
          assert.equal(job.status, 'completed');
          assert.equal(job.actual_micro_usd, 500);
        }
        if (scenario === '429-exhausted') {
          assert.equal(job.status, 'failed');
          assert.equal(job.actual_micro_usd, 0);
        }
        if (['timeout', 'stop'].includes(scenario)) {
          assert.equal(job.status, 'submission_unknown');
          assert.equal(job.actual_micro_usd, null);
          assert.ok(Number(job.reserved_micro_usd) > 0);
        }
        if (scenario === 'invalid-json') {
          assert.equal(job.status, 'failed');
          assert.equal(job.actual_micro_usd, 500);
        }
        if (scenario === 'budget') assert.equal(job.status, 'budget_stopped');
      } finally {
        sqlite.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
