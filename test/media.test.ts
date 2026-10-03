import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mediaUploadSchema } from '../src/shared/media';
import { pcmWav } from '../src/web/prepare-media';
import { wavSeconds, checkImage } from '../src/worker/asset-format';
import {
  createMediaJob,
  removeMediaAssets,
  retryMediaJob,
  reserveMedia,
} from '../src/worker/media-jobs';
import { sqliteRuntime } from './sqlite-runtime';
import { policy, fixtureRegistry, register } from './feed-fixtures';
import { deleteSource, hash } from '../src/worker/storage';
import { loadCapture } from '../src/worker/jobs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
function setup() {
  const runtime = sqliteRuntime(),
    objects = new Map<string, Uint8Array>();
  const instance = {
    status: async () => ({ status: 'queued' }),
    terminate: async () => {},
    restart: async () => {},
  };
  const env = {
    ...runtime.env,
    VISION_INPUT_TOKEN_BOUND: '50000',
    AUDIO_MICRO_USD_PER_SECOND: '100',
    MEDIA_BUCKET: {
      put: async (key: string, value: Uint8Array) => objects.set(key, value),
      get: async (key: string) =>
        objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.buffer } : null,
      delete: async (keys: string[]) => keys.forEach((key) => objects.delete(key)),
    },
    MEDIA_WORKFLOW: { create: async () => instance, get: async () => instance },
    HARVEST_WORKFLOW: { create: async () => instance, get: async () => instance },
  } as unknown as Env;
  return { ...runtime, env, objects };
}
test('PCM duration and image bounds are derived from bytes, so claimed duration/MIME cannot evade media bounds', () => {
  const wav = pcmWav(new Float32Array(16000));
  assert.equal(wavSeconds(wav), 1);
  const wrong = wav.slice();
  new DataView(wrong.buffer).setUint32(24, 1, true);
  assert.throws(() => wavSeconds(wrong), /invalid_pcm/);
  assert.deepEqual(checkImage(png, 'image/png'), { width: 1, height: 1 });
  assert.throws(() => checkImage(png, 'image/jpeg'), /dimensions/);
});
test('media failures preserve unknown spending, cap 429 retries, stop before unfunded calls, and reject receipts after deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-media-failure-'));
  const oldFetch = globalThis.fetch;
  try {
    const stub = join(dir, 'cloudflare.mjs');
    await writeFile(stub, 'export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}');
    await build({
      entryPoints: ['src/worker/media-workflow.ts'],
      outfile: join(dir, 'media.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'cloudflare:workers': stub },
      logLevel: 'silent',
    });
    const { MediaWorkflow } = await import(pathToFileURL(join(dir, 'media.mjs')).href);
    for (const scenario of ['timeout', '429', 'budget', 'delete']) {
      const runtime = setup();
      try {
        await register(runtime.db, fixtureRegistry({ ...policy(), media: ['image'] }));
        if (scenario === 'budget') runtime.env.DAILY_BUDGET_MICRO_USD = '1';
        const input = mediaUploadSchema.parse({
          registryId: 'fixture',
          url: `https://example.com/${scenario}`,
          kind: 'image',
          assets: [{ kind: 'image', mime: 'image/png', data: png.toString('base64') }],
        });
        const job = await createMediaJob(runtime.env, input);
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          if (scenario === 'timeout') throw new Error('ambiguous timeout');
          if (scenario === '429')
            return new Response('', { status: 429, headers: { 'retry-after': '1' } });
          if (scenario === 'delete') {
            const sourceId = await hash(input.url);
            const slug = runtime.sqlite
              .prepare('SELECT slug FROM sources WHERE id=?')
              .get(sourceId)!.slug;
            await deleteSource(runtime.db, String(slug), null);
            await removeMediaAssets(runtime.env, sourceId);
            return Response.json({
              id: 'late',
              status: 'completed',
              usage: { input_tokens: 100, output_tokens: 100 },
              output: [],
            });
          }
          throw new Error('unfunded provider call');
        };
        const step = {
          async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
            const fn = typeof options === 'function' ? options : callback!;
            const attempts = name.startsWith('extract media part') ? 3 : 1;
            let error: unknown;
            for (let i = 0; i < attempts; i++) {
              try {
                return await fn();
              } catch (e) {
                error = e;
              }
            }
            throw error;
          },
        };
        await assert.rejects(() =>
          new MediaWorkflow({}, runtime.env).run({ payload: { id: job.id } }, step),
        );
        const row = runtime.sqlite
          .prepare(
            'SELECT status,actual_micro_usd,reserved_micro_usd,result_json FROM jobs WHERE id=?',
          )
          .get(job.id)!;
        assert.equal(calls, scenario === 'budget' ? 0 : scenario === '429' ? 3 : 1);
        assert.equal(
          row.status,
          scenario === 'timeout'
            ? 'submission_unknown'
            : scenario === 'budget'
              ? 'budget_stopped'
              : scenario === 'delete'
                ? 'submission_unknown'
                : 'failed',
        );
        assert.equal(row.result_json, null);
        if (scenario === 'timeout' || scenario === 'delete') {
          assert.equal(row.actual_micro_usd, null);
          assert.ok(Number(row.reserved_micro_usd) > 0);
        }
        if (scenario === '429') assert.equal(row.actual_micro_usd, 0);
        assert.equal(runtime.sqlite.prepare('SELECT count(*) AS n FROM captures').get()!.n, 0);
        if (scenario === 'timeout')
          await assert.rejects(() => retryMediaJob(runtime.env, job.id), /job_not_retryable/);
        if (scenario === 'delete') {
          assert.equal(runtime.objects.size, 0);
          assert.equal(
            runtime.sqlite.prepare('SELECT result_json FROM job_parts WHERE job_id=?').get(job.id)!
              .result_json,
            null,
          );
        }
      } finally {
        runtime.sqlite.close();
      }
    }
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
test('video OCR and audio receipts normalize into cited paragraphs; replay has no paid calls and deletion removes originals but retains spending', async () => {
  const runtime = setup(),
    dir = await mkdtemp(join(tmpdir(), 'frontier-media-test-')),
    oldFetch = globalThis.fetch;
  try {
    const p = { ...policy(), media: ['video' as const] };
    await register(runtime.db, fixtureRegistry(p));
    const input = mediaUploadSchema.parse({
      registryId: 'fixture',
      url: 'https://example.com/video',
      kind: 'video',
      assets: [
        {
          kind: 'audio',
          mime: 'audio/wav',
          data: Buffer.from(pcmWav(new Float32Array(16000))).toString('base64'),
        },
        { kind: 'frame', mime: 'image/png', data: png.toString('base64'), seconds: 0.5 },
      ],
    });
    const job = await createMediaJob(runtime.env, input);
    assert.equal(runtime.objects.size, 2);
    await reserveMedia(runtime.env, job.id);
    // Simulate interruption after atomic budget reservation but before durable part rows.
    runtime.sqlite.prepare('DELETE FROM job_parts WHERE job_id=?').run(job.id);
    const stub = join(dir, 'cloudflare.mjs');
    await writeFile(stub, 'export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}');
    await build({
      entryPoints: ['src/worker/media-workflow.ts'],
      outfile: join(dir, 'media.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'cloudflare:workers': stub },
      logLevel: 'silent',
    });
    const { MediaWorkflow } = await import(pathToFileURL(join(dir, 'media.mjs')).href);
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith('/transcriptions')) {
        assert.equal((init!.body as FormData).get('model'), 'whisper-1');
        return Response.json({
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'The result is not independently verified.' }],
        });
      }
      const payload = JSON.parse(String(init!.body));
      assert.equal(payload.store, false);
      assert.equal('tools' in payload, false);
      assert.equal(payload.input[0].content[1].type, 'input_image');
      return Response.json({
        id: 'vision-fixture',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 100 },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  paragraphs: [
                    { assetIndex: 0, method: 'ocr', page: null, text: '8% lower cost.' },
                    {
                      assetIndex: 0,
                      method: 'visual_description',
                      page: null,
                      text: 'A chart with two bars.',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      });
    };
    const checkpoints = new Map<string, unknown>();
    const step = {
      async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
        if (checkpoints.has(name)) return checkpoints.get(name);
        const fn = typeof options === 'function' ? options : callback!;
        const result = await fn();
        checkpoints.set(name, result);
        return result;
      },
    };
    const workflow = new MediaWorkflow({}, runtime.env),
      event = { instanceId: job.id, payload: { id: job.id } };
    const result = await workflow.run(event, step);
    assert.equal(calls, 2);
    const capture = await loadCapture(runtime.db, result.captureId);
    assert.equal(capture.capture.paragraphs.length, 3);
    assert.equal(capture.capture.paragraphs[0].origin?.startSeconds, 0.5);
    assert.equal(capture.capture.paragraphs[1].origin?.method, 'visual_description');
    assert.equal(capture.capture.paragraphs[2].origin?.method, 'transcript');
    const cost = runtime.sqlite
      .prepare('SELECT actual_micro_usd FROM jobs WHERE id=?')
      .get(job.id)!.actual_micro_usd;
    assert.equal(cost, 400);
    await workflow.run(event, step);
    assert.equal(calls, 2);
    checkpoints.delete('extract media part 0');
    checkpoints.delete('extract media part 1');
    // Completed receipts cannot be submitted again even if checkpoint state is lost.
    await workflow.run(event, step);
    assert.equal(calls, 2);
    for (const value of checkpoints.values())
      assert.ok(!(JSON.stringify(value) || '').includes('lower cost'));
    const slug = (await runtime.db
      .prepare('SELECT slug FROM sources WHERE id=?')
      .bind(await hash(input.url))
      .first<{ slug: string }>())!.slug;
    await deleteSource(runtime.db, slug, null);
    await removeMediaAssets(runtime.env, await hash(input.url));
    assert.equal(runtime.objects.size, 0);
    assert.equal(
      runtime.sqlite
        .prepare('SELECT actual_micro_usd,result_json FROM jobs WHERE id=?')
        .get(job.id)!.actual_micro_usd,
      cost,
    );
    assert.equal(
      runtime.sqlite.prepare('SELECT result_json FROM jobs WHERE id=?').get(job.id)!.result_json,
      null,
    );
    await assert.rejects(() => createMediaJob(runtime.env, input), /source_deleted/);
  } finally {
    globalThis.fetch = oldFetch;
    runtime.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
