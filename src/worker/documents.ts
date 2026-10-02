import { Parser } from 'htmlparser2';
import {
  checkDns,
  validatePublicUrl,
  readTextBounded,
  plainHtml,
  type FeedPolicy,
  type Registry,
} from './feeds';
import { hash, StoreError } from './storage';
import { captureInputSchema, type CaptureInput } from './jobs';

export async function fetchPublic(
  url: string,
  p: FeedPolicy,
  request: typeof fetch = fetch,
  accept = '*/*',
) {
  const deadline = AbortSignal.timeout(20000);
  for (let hop = 0; hop <= 3; hop++) {
    const u = validatePublicUrl(url, p.allowedHosts);
    await checkDns(u.hostname, request, deadline);
    const r = await request(u.href, {
      redirect: 'manual',
      signal: deadline,
      headers: { Accept: accept },
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location || hop === 3) throw new StoreError('document_redirect_limit', 400);
      url = new URL(location, u).href;
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new StoreError(`document_http_${r.status}`, 400);
    }
    return { response: r, url: u.href };
  }
  throw new StoreError('document_redirect_limit', 400);
}

export async function readBytesBounded(r: Response, limit: number) {
  if (Number(r.headers.get('content-length') || 0) > limit) {
    await r.body?.cancel();
    throw new StoreError('asset_too_large', 400);
  }
  const reader = r.body?.getReader();
  if (!reader) throw new StoreError('asset_empty', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const v = await reader.read();
      if (v.done) break;
      length += v.value.length;
      if (length > limit) throw new StoreError('asset_too_large', 400);
      chunks.push(v.value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

export interface ArticleDocument {
  title: string;
  author: string;
  publishedAt?: string;
  paragraphs: CaptureInput['capture']['paragraphs'];
  images: string[];
  captions: string[];
  videos: string[];
  audio: string[];
}
export function parseArticle(html: string, url: string, p: FeedPolicy): ArticleDocument {
  if (!p.article) throw new StoreError('article_acquisition_not_permitted', 400);
  const selector = p.article.selector;
  const stack: Array<{ name: string; blocked: boolean; root: boolean }> = [];
  let roots = 0,
    text = '',
    title = '',
    inTitle = false,
    author = '',
    publishedAt: string | undefined;
  const assets = {
    images: [] as string[],
    captions: [] as string[],
    videos: [] as string[],
    audio: [] as string[],
  };
  const isBlocked = (name: string, a: Record<string, string>) =>
    /^(script|style|iframe|noscript|svg|form|nav|footer|aside)$/.test(name) ||
    'hidden' in a ||
    a['aria-hidden'] === 'true' ||
    /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '') ||
    /(?:^|[\s_-])(paywall|subscriber-only|premium-only|subscription-gate)(?:$|[\s_-])/i.test(
      `${a.class || ''} ${a.id || ''}`,
    );
  const asset = (value: string | undefined, list: string[]) => {
    if (!value) return;
    try {
      const target = validatePublicUrl(new URL(value, url).href, p.allowedHosts).href;
      if (!list.includes(target) && list.length < 4) list.push(target);
    } catch {}
  };
  const parser = new Parser(
    {
      onopentag(name, a) {
        const parent = stack.at(-1);
        const blocked = !!parent?.blocked || isBlocked(name, a);
        const match =
          selector[0] === '#'
            ? a.id === selector.slice(1)
            : selector[0] === '.'
              ? (a.class || '').split(/\s+/).includes(selector.slice(1))
              : name === selector;
        const root = !blocked && (!!parent?.root || match);
        if (match && !parent?.root && !blocked) roots++;
        if (stack.length >= 128) throw new StoreError('html_depth_limit', 400);
        stack.push({ name, blocked, root });
        if (name === 'title') inTitle = true;
        if (name === 'meta') {
          const key = a.property || a.name;
          if (key === 'og:title') title = a.content || title;
          if (key === 'author') author = a.content || author;
          if (key === 'article:published_time' && Number.isFinite(Date.parse(a.content)))
            publishedAt = new Date(a.content).toISOString();
        }
        if (root && !blocked) {
          if (/^(p|div|li|br|h[1-6]|blockquote)$/.test(name)) text += '\n';
          if (name === 'img') asset(a.src, assets.images);
          if (name === 'track' && ['captions', 'subtitles'].includes(a.kind))
            asset(a.src, assets.captions);
          if (name === 'video') asset(a.src, assets.videos);
          if (name === 'audio') asset(a.src, assets.audio);
          if (name === 'source') {
            const media = stack.findLast((s) => s.name === 'video' || s.name === 'audio');
            if (media) asset(a.src, media.name === 'video' ? assets.videos : assets.audio);
          }
        }
      },
      ontext(value) {
        if (inTitle && !title) title += value;
        const current = stack.at(-1);
        if (current?.root && !current.blocked) text += value;
      },
      onclosetag(name) {
        const current = stack.pop();
        if (name === 'title') inTitle = false;
        if (current?.root && !current.blocked && /^(p|div|li|h[1-6]|blockquote)$/.test(name))
          text += '\n';
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (roots !== 1) throw new StoreError('article_root_missing_or_ambiguous', 400);
  const paragraphs = text
    .split('\n')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, i) => ({
      id: `p${i + 1}`,
      text,
      origin: { kind: 'text' as const, method: 'publisher_text' as const, url },
    }));
  return {
    title: plainHtml(title).slice(0, 500) || url,
    author: plainHtml(author).slice(0, 500) || '著者表記なし',
    publishedAt,
    paragraphs,
    ...assets,
  };
}

const seconds = (time: string) => {
  const v = time.replace(',', '.').split(':').map(Number);
  if (
    v.length < 2 ||
    v.length > 3 ||
    v.some((n) => !Number.isFinite(n) || n < 0) ||
    v.slice(1).some((n) => n >= 60)
  )
    throw new StoreError('invalid_captions', 400);
  return v.reduce((n, v) => n * 60 + v, 0);
};
export function parseCaptions(value: string, url: string): CaptureInput['capture']['paragraphs'] {
  const cues: Array<{ text: string; start: number; end: number }> = [];
  for (const block of value.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const times = lines[i].trim().split(/\s+-->\s+/);
    const start = seconds(times[0]),
      end = seconds(times[1].split(/\s/)[0]);
    const text = plainHtml(lines.slice(i + 1).join(' '));
    if (!text) continue;
    if (end < start || start < (cues.at(-1)?.start || 0))
      throw new StoreError('invalid_captions', 400);
    cues.push({ text, start, end });
    if (cues.length > 2000) throw new StoreError('captions_too_large', 400);
  }
  if (!cues.length) throw new StoreError('captions_empty', 400);
  // Group cues without dropping words, so longer caption files don't exceed the paragraph cap.
  const groups: Array<{ text: string; start: number; end: number }> = [];
  for (const cue of cues) {
    const last = groups.at(-1);
    if (last && cue.end - last.start <= 30 && last.text.length + cue.text.length < 2000) {
      last.text += ' ' + cue.text;
      last.end = cue.end;
    } else groups.push({ ...cue });
  }
  return groups.map((c, i) => ({
    id: `p${i + 1}`,
    text: c.text,
    origin: {
      kind: 'video',
      method: 'publisher_caption',
      url,
      startSeconds: c.start,
      endSeconds: c.end,
    },
  }));
}

export async function documentCapture(
  row: Registry,
  p: FeedPolicy,
  url: string,
  paragraphs: CaptureInput['capture']['paragraphs'],
  metadata: Partial<CaptureInput['source']> = {},
) {
  const now = new Date().toISOString();
  const capture = captureInputSchema.parse({
    slug: `article-${(await hash(url)).slice(0, 24)}`,
    source: {
      url,
      title: url,
      publisher: row.name,
      author: '著者表記なし',
      language: 'en',
      publishedAt: now,
      capturedAt: now,
      publishedAtBasis: 'capture_time',
      ...metadata,
    },
    capture: {
      scope: '取得できた公開範囲のみ。未取得・有料部分は含みません。',
      mode: 'partial_translation',
      paragraphs,
      permissions: {
        store: p.store,
        ai: p.ai,
        translate: p.translate,
        basis: p.basis.join(' '),
        checkedAt: p.checkedAt,
        registryId: row.id,
        policyHash: await hash(row.policy_json),
      },
    },
  });
  if (!paragraphs.length) throw new StoreError('document_empty', 400);
  if (new TextEncoder().encode(JSON.stringify(capture)).length > 32000)
    throw new StoreError('capture_too_large_split_required', 400);
  return capture;
}

export async function acquireArticle(
  row: Registry,
  p: FeedPolicy,
  url: string,
  request: typeof fetch = fetch,
) {
  const { response, url: resolved } = await fetchPublic(url, p, request, 'text/html');
  if (!/^text\/html\b/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new StoreError('document_type_not_html', 400);
  }
  const article = parseArticle(await readTextBounded(response, 2_000_000), resolved, p);
  if (
    article.paragraphs.map((p) => p.text).join(' ').length < 300 &&
    article.captions.length &&
    p.media?.includes('captions')
  ) {
    const track = await fetchPublic(
      article.captions[0],
      p,
      request,
      'text/vtt,application/x-subrip,text/plain',
    );
    if (
      !/^(text\/vtt|application\/x-subrip|text\/plain)\b/i.test(
        track.response.headers.get('content-type') || '',
      )
    ) {
      await track.response.body?.cancel();
      throw new StoreError('invalid_captions', 400);
    }
    article.paragraphs = parseCaptions(await readTextBounded(track.response, 256000), url);
  }
  return documentCapture(row, p, url, article.paragraphs, {
    title: article.title,
    author: article.author,
    ...(article.publishedAt
      ? { publishedAt: article.publishedAt, publishedAtBasis: 'publisher' as const }
      : {}),
  });
}
