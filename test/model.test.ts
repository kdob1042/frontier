import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBundle } from '../src/shared/model';
import { demoBundle } from '../src/shared/demo';
import { parseResponse, responsePayload, verifyNumbers } from '../src/worker/openai';
import { aiConfig } from '../src/worker/jobs';

test('source-to-translation and all insight evidence must be complete and in scope', () => {
  assert.equal(validateBundle(demoBundle).rendering.claims.length, 2);
  const missing = structuredClone(demoBundle);
  missing.rendering.paragraphs.pop();
  assert.throws(() => validateBundle(missing), /missing_or_reordered/);
  const fabricated = structuredClone(demoBundle);
  fabricated.rendering.claims[0].evidence = ['paywalled-p5'];
  assert.throws(() => validateBundle(fabricated), /invalid_evidence/);
  const duplicate = structuredClone(demoBundle);
  duplicate.capture.paragraphs[1].id = 'p1';
  assert.throws(() => validateBundle(duplicate), /duplicate_paragraph/);
});
test('unpermitted original storage and translation are rejected', () => {
  const denied = structuredClone(demoBundle);
  denied.capture.permissions.store = false;
  assert.throws(() => validateBundle(denied), /storage_not_permitted/);
  denied.capture.permissions.store = true;
  denied.capture.permissions.translate = false;
  assert.throws(() => validateBundle(denied), /translation_not_permitted/);
  denied.capture.mode = 'link_only';
  assert.throws(() => validateBundle(denied), /link_only_has_content/);
});
test('a free excerpt cannot masquerade as a full article without full paragraph mapping', () => {
  const partial = structuredClone(demoBundle);
  partial.capture.mode = 'partial_translation';
  assert.equal(validateBundle(partial).capture.mode, 'partial_translation');
  partial.rendering.paragraphs.reverse();
  assert.throws(() => validateBundle(partial), /missing_or_reordered/);
  const url = structuredClone(demoBundle);
  url.source.url = 'javascript:alert(1)';
  assert.throws(() => validateBundle(url));
});
test('Responses has no search/tools, consumes original scope, handles refusals and incomplete usage', () => {
  const payload = responsePayload(demoBundle, 'configured-model');
  assert.equal('tools' in payload, false);
  assert.equal(payload.store, false);
  assert.equal(payload.text.format.strict, true);
  assert.ok(payload.input.includes(demoBundle.capture.paragraphs[0].text));
  const r = {
    id: 'resp_fixture',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(demoBundle.rendering) }],
      },
    ],
    usage: { input_tokens: 200, output_tokens: 300 },
  };
  assert.equal(parseResponse(r).generated.claims[0].evidence[0], 'p1');
  assert.throws(() => parseResponse({ ...r, status: 'incomplete' }), /incomplete/);
  assert.throws(() => parseResponse({ ...r, usage: null }), /usage_missing/);
  assert.throws(
    () => parseResponse({ ...r, output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
    /refusal/,
  );
});
test('numeric omissions and unfunded AI cannot silently pass', () => {
  verifyNumbers(demoBundle, demoBundle.rendering);
  const wrong = structuredClone(demoBundle.rendering);
  wrong.paragraphs[1].text = '不良率は低下しました。';
  assert.throws(() => verifyNumbers(demoBundle, wrong), /number_or_paragraph/);
  const negation = structuredClone(demoBundle.rendering);
  negation.paragraphs[3].text = '他の条件にも一般化できる。';
  assert.throws(() => verifyNumbers(demoBundle, negation), /negation_review/);
  const attribution = structuredClone(demoBundle.rendering);
  attribution.paragraphs[1].text =
    '3か月で不良率は8%から5%へ改善した。独立に検証された結果ではない。';
  assert.throws(() => verifyNumbers(demoBundle, attribution), /attribution_review/);
  assert.throws(
    () =>
      aiConfig({
        AI_ENABLED: 'true',
        OPENAI_MODEL: 'configured-model',
        OPENAI_API_KEY: 'unit-test',
        DAILY_BUDGET_MICRO_USD: '0',
        MONTHLY_BUDGET_MICRO_USD: '10',
        INPUT_MICRO_USD_PER_TOKEN: '1',
        OUTPUT_MICRO_USD_PER_TOKEN: '1',
      } as Env),
    /ai_not_configured/,
  );
});
