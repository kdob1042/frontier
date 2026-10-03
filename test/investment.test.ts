import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoBundle } from '../src/shared/demo';
import { importBundle, deleteSource } from '../src/worker/storage';
import {
  extractInvestment,
  investmentArticles,
  importInvestment,
  investmentState,
  validateTheses,
} from '../src/worker/investment';
import { retryJob } from '../src/worker/jobs';
import { sqliteRuntime } from './sqlite-runtime';
async function setup() {
  const r = sqliteRuntime();
  await importBundle(r.db, demoBundle);
  return r;
}
function output(revision: string, paragraphId: string) {
  return {
    theses: [
      {
        hypothesis: '工程学習が利益率を押し上げる',
        mechanism: '資料の実験結果からの仮説。継続性は未確認。',
        beneficiaries: '資料中の工場',
        headwinds: '効果が定着しない場合',
        counterEvidence: '歩留まり改善が止まる',
        indicators: '歩留まりと粗利率',
        horizon: '未確認',
        evidence: [{ revision, paragraphId }],
      },
    ],
    limitations: '取得範囲に限る。1本のみ。',
  };
}
function response(value: unknown) {
  return new Response(
    JSON.stringify({
      id: 'test_response',
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 200 },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
    }),
  );
}
test('investment confirmation, funding, grounded output and idempotent replay', async () => {
  const { env, db } = await setup();
  const { articles } = await investmentArticles(env);
  assert.equal(articles.length, 1);
  const request = { confirmed: true, requestId: crypto.randomUUID() };
  let calls = 0;
  const send = async () => {
    calls++;
    return response(output(articles[0].revision, articles[0].paragraphs[0].id));
  };
  await assert.rejects(extractInvestment(env, { ...request, confirmed: false }, send));
  assert.equal(calls, 0);
  const { id } = await extractInvestment(env, request, send);
  await extractInvestment(env, request, send);
  assert.equal(calls, 1);
  const state = await investmentState(env);
  assert.equal(state.run?.status, 'completed');
  assert.equal(state.run?.result?.theses.length, 1);
  assert.equal(
    (
      await db
        .prepare('SELECT actual_micro_usd FROM jobs WHERE id=?')
        .bind(id)
        .first<{ actual_micro_usd: number }>()
    )?.actual_micro_usd,
    500,
  );
  await assert.rejects(retryJob(env, id), /investment_retry/);
  await deleteSource(db, articles[0].slug, articles[0].revision);
  assert.equal((await investmentState(env)).run?.result, null);
  assert.equal(
    (
      await db
        .prepare('SELECT output_json FROM investment_runs WHERE job_id=?')
        .bind(id)
        .first<{ output_json: string | null }>()
    )?.output_json,
    null,
  );
});
test('unknown evidence, duplicate theses and more than ten are rejected', async () => {
  const { env } = await setup();
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  assert.throws(
    () => validateTheses(output(a.revision, 'invented'), articles),
    /invalid_thesis_evidence/,
  );
  const result = output(a.revision, a.paragraphs[0].id);
  result.theses.push(result.theses[0]);
  assert.throws(() => validateTheses(result, articles), /duplicate_thesis/);
  result.theses = Array(11).fill(result.theses[0]);
  assert.throws(() => validateTheses(result, articles));
});
test('AI off and insufficient budget never send; timeout stays charged and cannot auto replay', async () => {
  const { env, db } = await setup();
  let calls = 0;
  const send = async () => {
    calls++;
    throw new Error('timeout');
  };
  const request = { confirmed: true, requestId: crypto.randomUUID() };
  env.AI_ENABLED = 'false';
  await assert.rejects(extractInvestment(env, request, send));
  assert.equal(calls, 0);
  env.AI_ENABLED = 'true';
  env.DAILY_BUDGET_MICRO_USD = '1';
  await extractInvestment(env, { ...request, requestId: crypto.randomUUID() }, send);
  assert.equal(calls, 0);
  env.DAILY_BUDGET_MICRO_USD = '1000000';
  const { id } = await extractInvestment(env, request, send);
  await extractInvestment(env, request, send);
  assert.equal(calls, 1);
  const row = await db
    .prepare('SELECT status,actual_micro_usd,reserved_micro_usd FROM jobs WHERE id=?')
    .bind(id)
    .first<{ status: string; actual_micro_usd: number | null; reserved_micro_usd: number }>();
  assert.equal(row?.status, 'submission_unknown');
  assert.equal(row?.actual_micro_usd, null);
  assert.ok(row!.reserved_micro_usd > 0);
});
test('invalid paid output is accounted and a late result cannot restore deleted articles', async () => {
  for (const deleted of [false, true]) {
    const { env, db } = await setup();
    const { articles } = await investmentArticles(env);
    const a = articles[0];
    const { id } = await extractInvestment(
      env,
      { confirmed: true, requestId: crypto.randomUUID() },
      async () => {
        if (deleted) await deleteSource(db, a.slug, a.revision);
        return response(output(a.revision, deleted ? a.paragraphs[0].id : 'invented'));
      },
    );
    assert.equal((await investmentState(env)).run?.result, null);
    const row = await db
      .prepare('SELECT status,actual_micro_usd FROM jobs WHERE id=?')
      .bind(id)
      .first<{ status: string; actual_micro_usd: number | null }>();
    assert.notEqual(row?.status, 'completed');
    if (!deleted) assert.equal(row?.actual_micro_usd, 500);
  }
});
test('concurrent identical requests send once; revoked permissions exclude evidence', async () => {
  const { env, db } = await setup();
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  let calls = 0;
  const request = { confirmed: true, requestId: crypto.randomUUID() };
  const send = async () => {
    calls++;
    return response(output(a.revision, a.paragraphs[0].id));
  };
  await Promise.all([extractInvestment(env, request, send), extractInvestment(env, request, send)]);
  assert.equal(calls, 1);
  const denied = { ...demoBundle.capture.permissions, ai: false };
  await db
    .prepare('UPDATE captures SET permissions_json=? WHERE id=?')
    .bind(JSON.stringify(denied), a.captureId)
    .run();
  assert.equal((await investmentArticles(env)).articles.length, 0);
  assert.equal((await investmentState(env)).run?.result, null);
  await assert.rejects(
    extractInvestment(env, { ...request, requestId: crypto.randomUUID() }, send),
    /no_investment_evidence/,
  );
  assert.equal(calls, 1);
});

test('successful analysis consumes every selected revision, including zero-thesis results; new versions remain eligible', async () => {
  const { env, db } = await setup();
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  await extractInvestment(env, { confirmed: true, requestId: crypto.randomUUID() }, async () =>
    response({ theses: [], limitations: '十分な投資論点がなかった' }),
  );
  assert.equal((await investmentArticles(env)).articles.length, 0);
  assert.equal((await investmentState(env)).used, 1);
  assert.equal((await investmentState(env)).run?.result?.theses.length, 0);
  await assert.rejects(
    extractInvestment(env, { confirmed: true, requestId: crypto.randomUUID() }, async () => {
      throw new Error('must not send');
    }),
    /no_investment_evidence/,
  );
  const updated = structuredClone(demoBundle);
  updated.capture.paragraphs[0].text += ' Additional newly captured evidence.';
  await importBundle(db, updated, a.revision);
  assert.equal((await investmentArticles(env)).articles.length, 1);
  assert.equal((await investmentState(env)).used, 0);
});
test('failed analysis does not consume evidence and used IDs survive source deletion', async () => {
  const { env, db } = await setup();
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  await extractInvestment(env, { confirmed: true, requestId: crypto.randomUUID() }, async () =>
    response(output(a.revision, 'invented')),
  );
  assert.equal((await investmentArticles(env)).articles.length, 1);
  await extractInvestment(env, { confirmed: true, requestId: crypto.randomUUID() }, async () =>
    response(output(a.revision, a.paragraphs[0].id)),
  );
  await deleteSource(db, a.slug, a.revision);
  assert.ok(
    await db
      .prepare('SELECT revision FROM investment_used_revisions WHERE revision=?')
      .bind(a.revision)
      .first(),
  );
});
test('ChatGPT trial import works with API disabled and preserves evidence and used tracking', async () => {
  const { env, db } = await setup();
  env.AI_ENABLED = 'false';
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  const input = {
    confirmed: true,
    requestId: crypto.randomUUID(),
    revisions: [{ slug: a.slug, revision: a.revision }],
    result: output(a.revision, a.paragraphs[0].id),
  };
  const { id } = await importInvestment(env, input);
  assert.deepEqual(await importInvestment(env, input), { id });
  const state = await investmentState(env);
  assert.equal(state.run?.execution, 'chatgpt_import');
  assert.equal(state.run?.result?.theses.length, 1);
  assert.equal(state.used, 1);
  assert.equal(state.aiConfigured, false);
  assert.equal(
    (
      await db
        .prepare('SELECT actual_micro_usd FROM jobs WHERE id=?')
        .bind(id)
        .first<{ actual_micro_usd: number }>()
    )?.actual_micro_usd,
    0,
  );
  await assert.rejects(importInvestment(env, { ...input, requestId: crypto.randomUUID() }));
});
test('summary evidence is explicitly labelled AI-derived and may be cited without posing as original text', async () => {
  const { env, db } = sqliteRuntime();
  const summary = structuredClone(demoBundle);
  summary.capture.mode = 'summary';
  const imported = await importBundle(db, summary);
  const { articles } = await investmentArticles(env);
  const a = articles[0];
  assert.equal(a.paragraphs.find((p) => p.id === 'summary-1')?.basis, 'ai_summary');
  await importInvestment(env, {
    confirmed: true,
    requestId: crypto.randomUUID(),
    revisions: [{ slug: a.slug, revision: imported.revision }],
    result: output(a.revision, 'summary-1'),
  });
  assert.equal(
    (await investmentState(env)).run?.articles[0].paragraphs.find((p) => p.id === 'summary-1')
      ?.basis,
    'ai_summary',
  );
});
