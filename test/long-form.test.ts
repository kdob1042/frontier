import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sqliteRuntime } from './sqlite-runtime';
import { demoBundle } from '../src/shared/demo';
import { saveCapture, retryJob } from '../src/worker/jobs';
import { translationParts } from '../src/worker/long-form';
import { hash, getStory, deleteSource } from '../src/worker/storage';

test('bounded long translation keeps every source segment; a known rejected part resumes from saved receipts and all usage survives deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-long-')),
    originalFetch = globalThis.fetch,
    { db, env, sqlite } = sqliteRuntime();
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
    const raw = {
      slug: 'long-fixture',
      source: { ...demoBundle.source, url: 'https://example.com/long-fixture' },
      capture: {
        ...demoBundle.capture,
        paragraphs: [
          { id: 'p1', text: 'Production learning preserves operator reasons. '.repeat(180) },
          { id: 'p2', text: 'Manufacturing experiments improve deployment quality. '.repeat(170) },
        ],
      },
    };
    const plan = translationParts(raw);
    assert.ok(plan.length >= 2 && plan.length <= 4);
    for (const p of raw.capture.paragraphs)
      assert.equal(
        plan
          .flat()
          .filter((s) => s.originalId === p.id)
          .map((s) => s.text)
          .join(''),
        p.text,
      );
    const saved = await saveCapture(db, raw),
      id = await hash('long-pipeline'),
      now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO jobs(id,capture_id,processing_version,status,created_at,updated_at) VALUES(?,?,'fixture','queued',?,?)",
      )
      .bind(id, saved.captureId, now, now)
      .run();
    let calls = 0,
      restarts = 0;
    env.HARVEST_WORKFLOW = {
      async get() {
        return {
          async restart() {
            restarts++;
          },
          async status() {
            return { status: 'errored' };
          },
        };
      },
    } as unknown as Env['HARVEST_WORKFLOW'];
    globalThis.fetch = async (_url, init) => {
      calls++;
      if (calls === 2) return new Response(null, { status: 401 });
      const request = JSON.parse(init!.body as string),
        input = JSON.parse(request.input);
      const output = input.segments
        ? {
            paragraphs: input.segments.map((s: { sourceId: string }) => ({
              sourceId: s.sourceId,
              text: `保存された訳文 ${s.sourceId}。`,
            })),
          }
        : {
            title: '長文の検証',
            intro: '自作資料の分割処理を検証するfixture。',
            claims: [],
            concepts: [],
            questions: [],
            viewDraft: null,
            relations: [],
          };
      return Response.json({
        id: `resp_part_${calls}`,
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
        ],
        usage: { input_tokens: 100, output_tokens: 200 },
      });
    };
    const steps = () => {
      const checkpoints = new Map();
      return {
        checkpoints,
        async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
          if (checkpoints.has(name)) return checkpoints.get(name);
          const fn = typeof options === 'function' ? options : callback;
          if (!fn) throw Error('callback');
          const limit =
            typeof options === 'object'
              ? (options as { retries?: { limit: number } }).retries?.limit || 0
              : 0;
          for (let attempt = 0; ; attempt++) {
            try {
              const value = await fn();
              checkpoints.set(name, value);
              return value;
            } catch (e) {
              if (attempt >= limit) throw e;
            }
          }
        },
      };
    };
    const workflow = new HarvestWorkflow({}, env),
      event = { instanceId: id, payload: { captureId: saved.captureId, expectedRevision: null } };
    await assert.rejects(() => workflow.run(event, steps()));
    assert.equal(calls, 2);
    assert.equal(
      sqlite.prepare('SELECT actual_micro_usd FROM jobs WHERE id=?').get(id)!.actual_micro_usd,
      500,
    );
    await retryJob(env, id);
    assert.equal(restarts, 1);
    const checkpoint = steps();
    await workflow.run(event, checkpoint);
    assert.equal(
      calls,
      plan.length + 2,
      'only the rejected part and remaining stages may submit again',
    );
    const story = await getStory(db, raw.slug);
    assert.ok(story);
    assert.deepEqual(
      story.rendering.paragraphs.map((p) => p.sourceId),
      ['p1', 'p2'],
    );
    for (const segment of plan.flat())
      assert.ok(
        story.rendering.paragraphs
          .find((p) => p.sourceId === segment.originalId)!
          .text.includes(segment.id),
      );
    const expectedCost = (plan.length + 1) * 500;
    assert.equal(
      sqlite.prepare('SELECT actual_micro_usd FROM jobs WHERE id=?').get(id)!.actual_micro_usd,
      expectedCost,
    );
    checkpoint.checkpoints.delete('assemble long translation receipts');
    await workflow.run(event, checkpoint);
    assert.equal(calls, plan.length + 2);
    await deleteSource(db, raw.slug, story.revision);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM job_parts WHERE result_json IS NOT NULL').get()!.n,
      0,
    );
    assert.equal(
      sqlite.prepare('SELECT actual_micro_usd FROM jobs WHERE id=?').get(id)!.actual_micro_usd,
      expectedCost,
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
