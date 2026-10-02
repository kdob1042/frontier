import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Parser } from 'htmlparser2';
import { isIP } from 'node:net';
import { z } from 'zod';
import { safeUrl } from '../shared/model';
import { hash, StoreError } from './storage';
import { captureInputSchema, type CaptureInput } from './jobs';

export const policySchema = z
  .object({
    acquire: z.boolean(),
    store: z.boolean(),
    ai: z.boolean(),
    translate: z.boolean(),
    basis: z.array(safeUrl).min(1).max(5),
    checkedAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    allowedHosts: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .min(1)
      .max(5),
    scope: z.enum(['feed_excerpt', 'feed_full']),
    contentField: z.enum(['description', 'content:encoded', 'summary', 'content']),
    mode: z.enum(['partial_translation', 'full_translation', 'summary']),
    frequencyMinutes: z.number().int().min(60).max(10080),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.mode === 'full_translation' && p.scope !== 'feed_full')
      ctx.addIssue({
        code: 'custom',
        message: 'Full translation requires licensed full feed content',
      });
    if (
      Date.parse(p.validUntil) <= Date.parse(p.checkedAt) ||
      Date.parse(p.validUntil) - Date.parse(p.checkedAt) > 90 * 86400000
    )
      ctx.addIssue({ code: 'custom', message: 'Permission review must expire within 90 days' });
  });
export type FeedPolicy = z.infer<typeof policySchema>;
export interface Registry {
  id: string;
  name: string;
  homepage: string;
  feed_url: string | null;
  enabled: number;
  policy_json: string;
  last_attempt_at: string | null;
  etag: string | null;
  last_modified: string | null;
}
export function permittedPolicy(row: Registry, now = Date.now()): FeedPolicy {
  if (!row.enabled || row.id === 'contrary') throw new StoreError('source_disabled', 400);
  const p = policySchema.parse(JSON.parse(row.policy_json));
  if (!p.acquire || !p.store || Date.parse(p.checkedAt) > now || Date.parse(p.validUntil) <= now)
    throw new StoreError('source_policy_unconfirmed', 400);
  if (!row.feed_url) throw new StoreError('feed_unconfirmed', 400);
  validatePublicUrl(row.feed_url, p.allowedHosts);
  return p;
}
export async function configureRegistry(db: D1Database, id: string, input: unknown) {
  const setting = z
    .object({
      enabled: z.boolean(),
      feedUrl: safeUrl.nullable(),
      policy: policySchema.nullable(),
      reason: z.string().min(1).max(500),
    })
    .strict()
    .parse(input);
  const row = await db
    .prepare('SELECT * FROM source_registry WHERE id=?')
    .bind(id)
    .first<Registry>();
  if (!row) throw new StoreError('not_found', 404);
  const next = {
    ...row,
    enabled: Number(setting.enabled),
    feed_url: setting.feedUrl,
    policy_json: JSON.stringify(setting.policy || {}),
  };
  if (setting.enabled) permittedPolicy(next);
  await db
    .prepare(
      'UPDATE source_registry SET enabled=?,feed_url=?,policy_json=?,checked_at=?,reason=? WHERE id=?',
    )
    .bind(
      next.enabled,
      setting.feedUrl,
      next.policy_json,
      setting.policy?.checkedAt || null,
      setting.reason,
      id,
    )
    .run();
  return { saved: true };
}
export async function externalSourceStillPermitted(db: D1Database, url: string) {
  const row = await db
    .prepare(
      'SELECT r.* FROM source_registry r JOIN feed_candidates c ON c.registry_id=r.id WHERE c.canonical_url=? ORDER BY c.captured_at DESC LIMIT 1',
    )
    .bind(url)
    .first<Registry>();
  if (!row) return; // Owner-provided captures carry their own explicit permission record.
  const p = permittedPolicy(row);
  if (!p.ai || !p.translate) throw new StoreError('source_policy_changed', 400);
}

// Restrict requests to the explicitly reviewed publisher hosts; never accept arbitrary article URLs.
export function validatePublicUrl(value: string, hosts: string[]): URL {
  const u = new URL(value);
  const host = u.hostname.toLowerCase();
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    (u.port && u.port !== '443') ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    !host.includes('.') ||
    host.endsWith('.') ||
    !hosts.includes(host) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new StoreError('unsafe_source_url', 400);
  return u;
}
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only ordinary IPv6 global unicast. Excludes mapped IPv4, loopback, ULA, link-local and documentation.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(db8|0:|10:|20:)/i.test(address);
}
async function checkDns(host: string, request: typeof fetch, deadline: AbortSignal) {
  let found = false;
  for (const type of ['A', 'AAAA']) {
    const r = await request(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        redirect: 'error',
      },
    );
    if (!r.ok) throw new StoreError('dns_check_failed', 400);
    const raw = JSON.parse(await readTextBounded(r, 16000)) as {
      Status: number;
      Answer?: { type: number; data: string }[];
    };
    if (raw.Status !== 0) throw new StoreError('dns_check_failed', 400);
    for (const a of raw.Answer || [])
      if (a.type === 1 || a.type === 28) {
        found = true;
        if (!publicAddress(a.data)) throw new StoreError('private_source_address', 400);
      }
  }
  if (!found) throw new StoreError('dns_check_failed', 400);
}
export async function readTextBounded(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel();
    throw new StoreError('feed_too_large', 400);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new StoreError('feed_empty', 400);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let n = 0,
    result = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      n += part.value.length;
      if (n > limit) throw new StoreError('feed_too_large', 400);
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } catch (e) {
    await reader.cancel();
    throw e;
  }
}
export async function fetchFeed(row: Registry, p: FeedPolicy, request: typeof fetch = fetch) {
  let url = row.feed_url!;
  const deadline = AbortSignal.timeout(20000);
  for (let hop = 0; hop <= 3; hop++) {
    const u = validatePublicUrl(url, p.allowedHosts);
    await checkDns(u.hostname, request, deadline);
    const response = await request(u.href, {
      redirect: 'manual',
      signal: deadline,
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        ...(row.etag ? { 'If-None-Match': row.etag } : {}),
        ...(row.last_modified ? { 'If-Modified-Since': row.last_modified } : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 3) throw new StoreError('feed_redirect_limit', 400);
      url = new URL(location, u).href;
      continue;
    }
    if (response.status === 304)
      return { entries: null, etag: row.etag, modified: row.last_modified };
    if (!response.ok) {
      await response.body?.cancel();
      throw new StoreError(`feed_http_${response.status}`, 400);
    }
    if (!/(xml|rss|atom)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new StoreError('feed_type_not_xml', 400);
    }
    return {
      entries: parseFeed(await readTextBounded(response, 256000), row, p),
      etag: response.headers.get('etag')?.slice(0, 500) || null,
      modified: response.headers.get('last-modified')?.slice(0, 200) || null,
    };
  }
  throw new StoreError('feed_redirect_limit', 400);
}
function plainHtml(html: string) {
  let text = '',
    hidden = 0;
  const blocked = new Set(['script', 'style', 'iframe', 'noscript', 'svg', 'form']);
  const parser = new Parser(
    {
      onopentag(name) {
        if (blocked.has(name)) hidden++;
        if (!hidden && /^(p|div|li|br|h[1-6])$/.test(name)) text += '\n';
      },
      ontext(value) {
        if (!hidden) text += value;
      },
      onclosetag(name) {
        if (blocked.has(name) && hidden) hidden--;
        if (!hidden && /^(p|div|li|h[1-6])$/.test(name)) text += '\n';
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text
    .split('\n')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
type XmlNode = Record<string, unknown>;
const nodes = (v: unknown): XmlNode[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter((v) => typeof v === 'object') as XmlNode[];
const value = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number'
      ? String(v)
      : v && typeof v === 'object'
        ? value((v as XmlNode)['#text'])
        : '';
export interface FeedEntry {
  url: string;
  feedId: string;
  title: string;
  author: string;
  publishedAt: string;
  updatedAt: string;
  paragraphs: string[];
}
export function parseFeed(xml: string, row: Registry, p: FeedPolicy): FeedEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new StoreError('unsafe_or_invalid_xml', 400);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    processEntities: false,
    maxNestedTags: 64,
  }).parse(xml);
  const atom = !!parsed.feed;
  const entries = nodes(atom ? parsed.feed.entry : parsed.rss?.channel?.item);
  if (!parsed.feed && !parsed.rss) throw new StoreError('unsupported_feed', 400);
  const result: FeedEntry[] = [];
  for (const e of entries.slice(0, 40)) {
    try {
      const link = atom
        ? nodes(e.link).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href']
        : e.link;
      const url = canonicalUrl(validatePublicUrl(value(link), p.allowedHosts).href);
      const title = plainHtml(value(e.title)).slice(0, 500);
      const published = value(atom ? e.published || e.updated : e.pubDate);
      if (!title || !published || !Number.isFinite(Date.parse(published))) continue;
      const publishedAt = new Date(published).toISOString();
      const updated = value(atom ? e.updated : e['dc:date']) || published;
      if (!Number.isFinite(Date.parse(updated))) continue;
      const text = plainHtml(value(e[p.contentField]));
      // A feed cannot grant access to a paid article. Preserve only its explicitly licensed field.
      const paragraphs = text.split('\n').filter(Boolean);
      if (
        paragraphs.length > 80 ||
        paragraphs.some((t) => t.length > 12000) ||
        new TextEncoder().encode(text).length > 24000
      )
        continue;
      result.push({
        url,
        feedId: value(atom ? e.id : e.guid) || url,
        title,
        author:
          plainHtml(value(atom ? nodes(e.author)[0]?.name : e['dc:creator'] || e.author)).slice(
            0,
            500,
          ) || 'フィード内に著者表記なし',
        publishedAt,
        updatedAt: new Date(updated).toISOString(),
        paragraphs,
      });
    } catch {
      /* Invalid or disallowed entry is never fetched. */
    }
  }
  return result;
}
export function canonicalUrl(value: string) {
  const u = new URL(value);
  u.hash = '';
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$|mc_)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.href;
}
export async function ingestFeed(
  db: D1Database,
  id: string,
  request: typeof fetch = fetch,
  now = new Date(),
  limit = 10,
) {
  const row = await db
    .prepare('SELECT * FROM source_registry WHERE id=?')
    .bind(id)
    .first<Registry>();
  if (!row) throw new StoreError('not_found', 404);
  const p = permittedPolicy(row, now.getTime());
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const cutoff = new Date(now.getTime() - p.frequencyMinutes * 60000).toISOString();
  const lease = await db
    .prepare(
      'UPDATE source_registry SET last_attempt_at=?,error_code=NULL WHERE id=? AND enabled=1 AND policy_json=? AND (last_attempt_at IS NULL OR last_attempt_at<=?)',
    )
    .bind(now.toISOString(), id, row.policy_json, cutoff)
    .run();
  if (!lease.meta.changes) return { status: 'skipped', reason: 'frequency_limit', candidates: 0 };
  try {
    const response = await fetchFeed(row, p, request);
    let count = 0;
    for (const e of (response.entries || []).slice(0, Math.min(10, Math.max(0, limit)))) {
      const tombstone = await db
        .prepare('SELECT deleted_at,hidden FROM sources WHERE canonical_url=?')
        .bind(e.url)
        .first<{ deleted_at: string | null; hidden: number }>();
      if (tombstone?.deleted_at || tombstone?.hidden) continue;
      const fingerprint = await hash(
        e.paragraphs.map((t) => t.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()),
      );
      const candidateId = await hash([id, e.url, fingerprint]);
      const titleKey = e.title
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
      const duplicate =
        e.paragraphs.length &&
        (await db
          .prepare(
            "SELECT id FROM feed_candidates WHERE fingerprint=? AND canonical_url<>? AND status NOT IN('deleted','insufficient') LIMIT 1",
          )
          .bind(fingerprint, e.url)
          .first());
      const content: CaptureInput = {
        slug: `article-${(await hash(e.url)).slice(0, 24)}`,
        source: {
          url: e.url,
          title: e.title,
          publisher: row.name,
          author: e.author,
          language: 'en',
          publishedAt: e.publishedAt,
          updatedAt: e.updatedAt,
          capturedAt: now.toISOString(),
        },
        capture: {
          scope:
            p.scope === 'feed_full'
              ? '許可済みのフィード全文のみ。リンク先は取得していません。'
              : '許可済みのフィード公開部分のみ。リンク先・有料部分は取得していません。',
          mode: p.mode,
          paragraphs: e.paragraphs.map((text, i) => ({ id: `p${i + 1}`, text })),
          permissions: {
            store: p.store,
            ai: p.ai,
            translate: p.translate,
            basis: p.basis.join(' '),
            checkedAt: p.checkedAt,
          },
        },
      };
      const meaningful =
        e.paragraphs.join(' ').length >= 300 && Date.parse(e.publishedAt) <= now.getTime() + 60000;
      const canProcess = meaningful && p.ai && p.translate;
      const score = meaningful
        ? Math.min(
            5,
            (
              e.paragraphs
                .join(' ')
                .match(
                  /\b(cost|scale|process|deploy|trial|manufactur|efficien|experiment|mechanism|production)\w*\b/gi,
                ) || []
            ).length,
          ) + (/\d/.test(e.paragraphs.join(' ')) ? 2 : 0)
        : 0;
      const inserted = await db
        .prepare(
          'INSERT INTO feed_candidates(id,registry_id,canonical_url,feed_id,title,published_at,updated_at,captured_at,discovered_day,fingerprint,title_key,content_json,status,reason,score) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM source_registry WHERE id=? AND enabled=1 AND policy_json=?) AND NOT EXISTS(SELECT 1 FROM sources WHERE canonical_url=? AND (deleted_at IS NOT NULL OR hidden=1)) AND (SELECT COUNT(*) FROM feed_candidates WHERE discovered_day=?)<10 ON CONFLICT DO NOTHING',
        )
        .bind(
          candidateId,
          id,
          e.url,
          e.feedId.slice(0, 2000),
          e.title,
          e.publishedAt,
          e.updatedAt,
          now.toISOString(),
          day,
          fingerprint,
          titleKey,
          JSON.stringify(captureInputSchema.parse(content)),
          duplicate ? 'duplicate' : canProcess ? 'candidate' : 'insufficient',
          duplicate
            ? 'same_original_content'
            : canProcess
              ? `mechanism_signals:${score};licensed_scope:${p.scope}`
              : meaningful
                ? 'processing_not_permitted'
                : 'insufficient_public_text',
          score,
          id,
          row.policy_json,
          e.url,
          day,
        )
        .run();
      count += Number(inserted.meta.changes);
    }
    await db
      .prepare(
        'UPDATE source_registry SET etag=?,last_modified=?,last_success_at=?,error_code=NULL WHERE id=? AND policy_json=?',
      )
      .bind(response.etag, response.modified, now.toISOString(), id, row.policy_json)
      .run();
    return {
      status: 'completed',
      reason: response.entries ? 'feed_checked' : 'not_modified',
      candidates: count,
    };
  } catch (error) {
    await db
      .prepare('UPDATE source_registry SET error_code=? WHERE id=?')
      .bind(error instanceof StoreError ? error.code : 'feed_failed', id)
      .run();
    throw error;
  }
}
