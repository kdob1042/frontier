import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoStory } from '../src/shared/demo';
import { makeSpeechPlan, speechChunks } from '../src/shared/speech';

test('speech retains paragraph wording, repeated numbers, negatives and Unicode in bounded utterances', () => {
  const text =
    '工程は変わらない。8%から8%への変化は確認していない。' + '😀報告によると未検証'.repeat(60);
  const pieces = speechChunks(text, '本文');
  assert.equal(pieces.map((p) => p.text).join(''), text);
  assert.ok(pieces.every((p) => Array.from(p.text).length <= 180));
  assert.ok(pieces.every((p) => !p.text.includes('\uFFFD')));
  assert.equal(
    speechChunks('出典 https://example.com/long/article', '本文')[0].text,
    '出典 原文リンク',
  );
});
test('listening uses saved Japanese revision, announces source scope and AI caveats, and never invents audio for link-only records', () => {
  const story = demoStory();
  const plan = makeSpeechPlan(story);
  const combined = plan.map((p) => p.text).join('');
  for (const p of story.rendering.paragraphs) assert.ok(combined.includes(p.text));
  assert.ok(combined.includes(story.capture.scope));
  assert.ok(combined.includes(story.source.author));
  assert.ok(combined.includes('AIが抽出した知見'));
  for (const c of story.rendering.claims) if (c.caveat) assert.ok(combined.includes(c.caveat));
  story.mode = 'link_only';
  assert.deepEqual(makeSpeechPlan(story), []);
});
