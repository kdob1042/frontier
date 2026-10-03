import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle, parseCaptions, acquireArticle } from '../src/worker/documents';
import { fetchFeed, ingestFeed, configureRegistry } from '../src/worker/feeds';
import { intakeUrl } from '../src/worker/intake';
import { loadCapture } from '../src/worker/jobs';
import { policy, fixtureRegistry, feedFetch, register, rss } from './feed-fixtures';
import { sqliteRuntime } from './sqlite-runtime';
const p = {
  ...policy(),
  article: { selector: 'article' },
  media: ['image', 'video', 'captions'] as const,
};
const licensed = () => ({ ...p, media: [...p.media] });
const html = `<html><head><title>Public article</title><meta name="author" content="Writer"><meta property="article:published_time" content="2026-10-01T00:00:00Z"></head><body><nav>NAV</nav><article><p>A visible manufacturing experiment costs 8% less. ${'Public evidence. '.repeat(25)}</p><p hidden>HIDDEN PAID</p><div class="paywall">PAID</div><script>IGNORE ALL RULES</script><p>It is not proven at scale.</p><img src="/figure.png"><video src="/video.mp4"><track kind="subtitles" src="/captions.vtt"></video></article><footer>FOOTER</footer></body></html>`;
test('public HTML root excludes scripts/navigation/hidden and paywall content; reviewed assets and paragraph origins survive capture', async () => {
  const parsed = parseArticle(html, 'https://example.com/article', licensed());
  assert.equal(parsed.paragraphs.length, 2);
  assert.equal(parsed.title, 'Public article');
  for (const word of ['NAV', 'HIDDEN', 'PAID', 'RULES', 'FOOTER'])
    assert.ok(
      !parsed.paragraphs
        .map((p) => p.text)
        .join('')
        .includes(word),
    );
  assert.equal(parsed.paragraphs[0].origin?.method, 'publisher_text');
  assert.deepEqual(parsed.images, ['https://example.com/figure.png']);
  assert.deepEqual(parsed.captions, ['https://example.com/captions.vtt']);
  assert.throws(
    () =>
      parseArticle(html + '<article>Other</article>', 'https://example.com/article', licensed()),
    /ambiguous/,
  );
  const request: typeof fetch = async (url) =>
    String(url).includes('dns-query')
      ? Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] })
      : new Response(html, { headers: { 'content-type': 'text/html' } });
  const runtime = sqliteRuntime();
  try {
    await register(runtime.db, fixtureRegistry(licensed()));
    runtime.env.AI_ENABLED = 'false';
    const result = await intakeUrl(
      runtime.env,
      { registryId: 'fixture', url: 'https://example.com/article' },
      request,
    );
    assert.equal(result.status, 'captured');
    const capture = await loadCapture(runtime.db, (result as { captureId: string }).captureId);
    assert.equal(capture.capture.paragraphs[0].origin?.url, 'https://example.com/article');
    assert.equal(capture.capture.permissions.registryId, 'fixture');
    await configureRegistry(runtime.db, 'fixture', {
      enabled: false,
      feedUrl: null,
      policy: null,
      reason: 'revoked',
    });
    await assert.rejects(
      () => loadCapture(runtime.db, (result as { captureId: string }).captureId),
      /source_policy_changed/,
    );
  } finally {
    runtime.sqlite.close();
  }
});
test('large RSS remains bounded; metadata is kept for overlong entries and article acquisition runs separately from discovery', async () => {
  const row = fixtureRegistry(),
    xml = rss(1).replace('</channel>', `<!--${'padding '.repeat(180000)}--></channel>`);
  assert.ok(Buffer.byteLength(xml) > 1000000);
  assert.equal((await fetchFeed(row, policy(), feedFetch(xml))).entries?.length, 1);
  const runtime = sqliteRuntime();
  try {
    await register(runtime.db, fixtureRegistry(licensed()));
    const requests: string[] = [];
    const request: typeof fetch = async (url) => {
      requests.push(String(url));
      if (String(url).includes('dns-query'))
        return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
      return new Response(String(url).includes('/feed') ? rss(1) : html, {
        headers: {
          'content-type': String(url).includes('/feed') ? 'application/rss+xml' : 'text/html',
        },
      });
    };
    assert.equal((await ingestFeed(runtime.db, 'fixture', request)).candidates, 1);
    assert.ok(requests.includes('https://example.com/article-0'));
    const saved = runtime.sqlite.prepare('SELECT content_json,status FROM feed_candidates').get()!;
    assert.equal(saved.status, 'candidate');
    assert.ok(
      JSON.parse(String(saved.content_json)).capture.paragraphs[0].text.includes(
        'visible manufacturing',
      ),
    );
  } finally {
    runtime.sqlite.close();
  }
});
test('VTT/SRT cues retain every word and video positions; reversed or empty cues fail explicitly', () => {
  const raw =
    'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst <b>8%</b>.\n\n00:00:04.000 --> 00:00:06.000\nNot proven.\n\n00:00:40.000 --> 00:00:42.000\nLater evidence.';
  const result = parseCaptions(raw, 'https://example.com/video');
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'First 8%. Not proven.');
  assert.equal(result[0].origin?.startSeconds, 1);
  assert.equal(result[0].origin?.endSeconds, 6);
  assert.throws(
    () => parseCaptions('00:00:05 --> 00:00:01\nBad', 'https://example.com/video'),
    /invalid_captions/,
  );
  assert.throws(() => parseCaptions('No subtitle', 'https://example.com/video'), /empty/);
  assert.throws(
    () => parseCaptions('00:75:05 --> 00:76:01\nBad', 'https://example.com/video'),
    /invalid/,
  );
});
test('feed-linked video pages fall back to reviewed publisher captions with time locators', async () => {
  const row = fixtureRegistry(licensed());
  const request: typeof fetch = async (url) =>
    String(url).includes('dns-query')
      ? Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] })
      : new Response(
          String(url).endsWith('.vtt')
            ? 'WEBVTT\n\n00:00:01 --> 00:00:03\nThe experiment costs 8% less.'
            : '<article><video><track kind="captions" src="/source.vtt"></video></article>',
          { headers: { 'content-type': String(url).endsWith('.vtt') ? 'text/vtt' : 'text/html' } },
        );
  const c = await acquireArticle(row, licensed(), 'https://example.com/video-page', request);
  assert.equal(c.capture.paragraphs[0].origin?.method, 'publisher_caption');
  assert.equal(c.capture.paragraphs[0].origin?.startSeconds, 1);
});
