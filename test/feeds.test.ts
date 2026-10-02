import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureRegistry,
  fetchFeed,
  ingestFeed,
  parseFeed,
  permittedPolicy,
  publicAddress,
  validatePublicUrl,
  type FeedPolicy,
  type Registry,
} from '../src/worker/feeds';
import { sqliteRuntime } from './sqlite-runtime';

import { policy, fixtureRegistry, rss, feedFetch, register } from './feed-fixtures';

test('RSS and Atom preserve only licensed fields, dates and canonical URLs; scripts, entities and private links are excluded', () => {
  const row = fixtureRegistry(),
    p = policy();
  const result = parseFeed(rss(), row, p);
  assert.equal(result.length, 2);
  assert.equal(result[0].url, 'https://example.com/article-0');
  assert.equal(result[0].paragraphs.length, 4);
  assert.ok(!result[0].paragraphs.join('').includes('unsafe'));
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-1</id><title>Test</title><link rel="alternate" href="https://example.com/atom"/><published>${new Date().toISOString()}</published><updated>${new Date().toISOString()}</updated><author><name>Writer</name></author><summary type="html">&lt;p&gt;Public excerpt &amp;amp; only.&lt;/p&gt;</summary><content>PAID TEXT MUST NOT APPEAR</content></entry></feed>`;
  const entries = parseFeed(atom, row, { ...p, contentField: 'summary' });
  assert.equal(entries[0].author, 'Writer');
  assert.ok(entries[0].paragraphs.join('').includes('Public excerpt'));
  assert.ok(!entries[0].paragraphs.join('').includes('PAID'));
  assert.throws(
    () => parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', row, p),
    /unsafe/,
  );
  assert.throws(() => parseFeed('<rss>', row, p), /invalid/);
  assert.throws(() => permittedPolicy({ ...row, id: 'contrary' }), /disabled/);
  assert.throws(() =>
    permittedPolicy({ ...row, policy_json: JSON.stringify({ ...p, validUntil: p.checkedAt }) }),
  );
  for (const url of [
    'http://example.com/a',
    'https://127.0.0.1/a',
    'https://user:pass@example.com/a',
    'https://example.com:444/a',
    'https://evil.example.net/a',
  ])
    assert.throws(() => validatePublicUrl(url, p.allowedHosts));
  for (const address of [
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '100.64.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  // Reserved /24s must not reject the whole /16 (TechCrunch resolves in 192.0.66.0/24).
  for (const address of [
    '192.0.66.220',
    '192.0.3.1',
    '198.51.99.1',
    '198.51.101.1',
    '203.0.112.1',
    '203.0.114.1',
  ])
    assert.equal(publicAddress(address), true);
});
test('public DNS, every redirect, response size and type are checked before content is accepted', async () => {
  const row = fixtureRegistry(),
    p = policy();
  await assert.rejects(
    () =>
      fetchFeed(row, p, async () =>
        Response.json({ Status: 0, Answer: [{ type: 1, data: '10.0.0.1' }] }),
      ),
    /private/,
  );
  let feedCalls = 0;
  await assert.rejects(
    () =>
      fetchFeed(row, p, async (url) => {
        if (String(url).includes('dns-query'))
          return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
        feedCalls++;
        return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/' } });
      }),
    /unsafe/,
  );
  assert.equal(feedCalls, 1);
  const bad: typeof fetch = async (url) =>
    String(url).includes('dns-query')
      ? Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] })
      : new Response('x', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(() => fetchFeed(row, p, bad), /not_xml/);
  await assert.rejects(() => fetchFeed(row, p, feedFetch('x'.repeat(256001))), /too_large/);
});
test('ingestion persists candidates once, respects frequency and global daily cap, identifies reprints and major updates', async () => {
  const { db, sqlite } = sqliteRuntime();
  try {
    await register(db);
    await ingestFeed(db, 'fixture', feedFetch(rss(1)));
    await db.prepare('UPDATE source_registry SET last_attempt_at=NULL').run();
    const update = await ingestFeed(db, 'fixture', feedFetch(rss(1, true)));
    assert.equal(update.candidates, 1, 'changed original content creates a new candidate version');
    await db.prepare('DELETE FROM feed_candidates').run();
    await db.prepare('UPDATE source_registry SET last_attempt_at=NULL').run();
    const result = await ingestFeed(db, 'fixture', feedFetch(rss(12)));
    assert.equal(result.candidates, 10);
    assert.equal((await ingestFeed(db, 'fixture', feedFetch())).reason, 'frequency_limit');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM feed_candidates').get()!.n, 10);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM feed_candidates WHERE status='duplicate'").get()!.n,
      8,
    );
    // A policy expiry or revocation stops acquisition before any request.
    await configureRegistry(db, 'fixture', {
      enabled: false,
      feedUrl: null,
      policy: null,
      reason: 'revoked',
    });
    await assert.rejects(() => ingestFeed(db, 'fixture', feedFetch()), /disabled/);
  } finally {
    sqlite.close();
  }
});
