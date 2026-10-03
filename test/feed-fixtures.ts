import { demoBundle } from '../src/shared/demo';
import type { FeedPolicy, Registry } from '../src/worker/feeds';
export function policy(now = new Date()): FeedPolicy {
  return {
    acquire: true,
    store: true,
    ai: true,
    translate: true,
    basis: ['https://example.com/self-authored-fixture'],
    checkedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 86400000).toISOString(),
    allowedHosts: ['example.com'],
    scope: 'feed_excerpt',
    contentField: 'description',
    mode: 'partial_translation',
    frequencyMinutes: 60,
  };
}
export function fixtureRegistry(p = policy()): Registry {
  return {
    id: 'fixture',
    name: '自作フィード',
    homepage: 'https://example.com/',
    feed_url: 'https://example.com/feed',
    enabled: 1,
    policy_json: JSON.stringify(p),
    last_attempt_at: null,
    etag: null,
    last_modified: null,
  };
}
export function rss(count = 2, changed = false) {
  const content = demoBundle.capture.paragraphs
    .map((p) => `<p>${p.text}${changed ? ' A revised production process.' : ''}</p>`)
    .join('');
  return `<rss version="2.0"><channel>${Array.from({ length: count }, (_, i) => `<item><guid>fixture-${i}</guid><title>Process learning ${i}</title><link>https://example.com/article-${i}?utm_source=test</link><pubDate>${new Date().toUTCString()}</pubDate><description><![CDATA[${content}${i % 2 ? ' Additional manufacturing experiment.' : ''}<script>unsafe()</script>]]></description></item>`).join('')}</channel></rss>`;
}
export const feedFetch =
  (xml = rss()): typeof fetch =>
  async (url) =>
    String(url).startsWith('https://cloudflare-dns.com/')
      ? Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] })
      : new Response(xml, {
          headers: { 'Content-Type': 'application/rss+xml', ETag: '"fixture"' },
        });
export async function register(db: D1Database, row = fixtureRegistry()) {
  await db
    .prepare(
      'INSERT INTO source_registry(id,name,homepage,feed_url,enabled,policy_json,reason) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      row.id,
      row.name,
      row.homepage,
      row.feed_url,
      row.enabled,
      row.policy_json,
      'Self-authored fixture only',
    )
    .run();
}
