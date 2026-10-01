import {
  validateBundle,
  type Bundle,
  type Generated,
  type Story,
  type StorySummary,
} from '../shared/model';

export class StoreError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}
const parse = <T>(v: string): T => JSON.parse(v) as T;
interface Head {
  id: string;
  slug: string;
  current_revision: string | null;
  deleted_at: string | null;
}
interface StoryRow {
  id: string;
  slug: string;
  canonical_url: string;
  metadata_json: string;
  revision: string;
  title: string;
  intro: string;
  paragraphs_json: string;
  mode: Bundle['capture']['mode'];
  scope: string;
  original_json: string;
  permissions_json: string;
  captured_at: string;
  fraction: number | null;
}
const storySelect = `SELECT s.id,s.slug,s.canonical_url,s.metadata_json,r.id AS revision,r.title,r.intro,r.paragraphs_json,c.mode,c.scope,c.paragraphs_json AS original_json,c.permissions_json,c.captured_at,p.fraction FROM sources s JOIN renderings r ON r.id=s.current_revision JOIN captures c ON c.id=r.capture_id LEFT JOIN reading_progress p ON p.source_id=s.id WHERE s.deleted_at IS NULL`;
export function summary(row: StoryRow): StorySummary {
  const meta = parse<Bundle['source']>(row.metadata_json);
  const ps = parse<Generated['paragraphs']>(row.paragraphs_json);
  return {
    slug: row.slug,
    revision: row.revision,
    title: row.title,
    intro: row.intro,
    publisher: meta.publisher,
    publishedAt: meta.publishedAt,
    mode: row.mode,
    minutes: Math.max(1, Math.ceil(ps.reduce((n, p) => n + p.text.length, 0) / 500)),
    progress: row.fraction || 0,
  };
}
export async function listStories(db: D1Database, query = '') {
  const search = query.slice(0, 200).replace(/[\\%_]/g, (x) => `\\${x}`);
  const sql = `${storySelect} AND (?='' OR r.title LIKE ? ESCAPE '\\' OR r.intro LIKE ? ESCAPE '\\' OR r.paragraphs_json LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM claims k WHERE k.rendering_id=r.id AND k.text LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM view_revisions v WHERE v.source_id=s.id AND v.text LIKE ? ESCAPE '\\')) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`;
  const rows = await db
    .prepare(sql)
    .bind(search, ...Array(5).fill(`%${search}%`))
    .all<StoryRow>();
  return rows.results.map(summary);
}
export async function getStory(db: D1Database, slug: string): Promise<Story | null> {
  const row = await db.prepare(`${storySelect} AND s.slug=?`).bind(slug).first<StoryRow>();
  if (!row) return null;
  const claims = (
    await db
      .prepare(
        'SELECT local_id,text,kind,evidence_json,caveat FROM claims WHERE rendering_id=? ORDER BY rowid',
      )
      .bind(row.revision)
      .all<{
        local_id: string;
        text: string;
        kind: Generated['claims'][number]['kind'];
        evidence_json: string;
        caveat: string;
      }>()
  ).results;
  const concepts = (
    await db
      .prepare(
        'SELECT c.name,c.meaning FROM concepts c JOIN rendering_concepts rc ON rc.concept_id=c.id WHERE rc.rendering_id=?',
      )
      .bind(row.revision)
      .all<{ name: string; meaning: string }>()
  ).results;
  const questions = (
    await db
      .prepare('SELECT text,evidence_json FROM questions WHERE rendering_id=?')
      .bind(row.revision)
      .all<{ text: string; evidence_json: string }>()
  ).results;
  const drafts = (
    await db
      .prepare(
        'SELECT d.id,d.text,d.evidence_json,EXISTS(SELECT 1 FROM view_revisions v WHERE v.draft_id=d.id) AS adopted FROM view_drafts d WHERE d.rendering_id=?',
      )
      .bind(row.revision)
      .all<{ id: string; text: string; evidence_json: string; adopted: number }>()
  ).results;
  const views = (
    await db
      .prepare(
        'SELECT id,text,created_at,evidence_missing FROM view_revisions WHERE source_id=? ORDER BY created_at DESC',
      )
      .bind(row.id)
      .all<{ id: string; text: string; created_at: string; evidence_missing: number }>()
  ).results;
  // A shared concept is a navigation hint. It is never labelled as support or causation.
  const connections = (
    await db
      .prepare(
        `SELECT DISTINCT s.slug,r.title,c.name AS concept FROM rendering_concepts mine JOIN concepts c ON c.id=mine.concept_id JOIN rendering_concepts other ON other.concept_id=c.id JOIN renderings r ON r.id=other.rendering_id JOIN sources s ON s.current_revision=r.id WHERE mine.rendering_id=? AND other.rendering_id<>? AND s.deleted_at IS NULL LIMIT 3`,
      )
      .bind(row.revision, row.revision)
      .all<{ slug: string; title: string; concept: string }>()
  ).results;
  return {
    ...summary(row),
    source: parse(row.metadata_json),
    capturedAt: row.captured_at,
    capture: {
      scope: row.scope,
      mode: row.mode,
      paragraphs: parse(row.original_json),
      permissions: parse(row.permissions_json),
    },
    rendering: {
      title: row.title,
      intro: row.intro,
      paragraphs: parse(row.paragraphs_json),
      claims: claims.map((c) => ({
        id: c.local_id,
        text: c.text,
        kind: c.kind,
        evidence: parse(c.evidence_json),
        caveat: c.caveat,
      })),
      concepts,
      questions: questions.map((q) => ({ text: q.text, evidence: parse(q.evidence_json) })),
      viewDraft: null,
    },
    drafts: drafts.map((d) => ({
      id: d.id,
      text: d.text,
      evidence: parse(d.evidence_json),
      adopted: !!d.adopted,
    })),
    views: views.map((v) => ({
      id: v.id,
      text: v.text,
      createdAt: v.created_at,
      evidenceMissing: !!v.evidence_missing,
    })),
    connections,
  };
}
export async function importBundle(db: D1Database, input: unknown, expected: string | null = null) {
  const b = validateBundle(input);
  const sourceId = await hash(b.source.url);
  const captureId = await hash([
    sourceId,
    b.capture,
    b.source.title,
    b.source.publisher,
    b.source.author,
    b.source.publishedAt,
  ]);
  const revision = await hash([captureId, b.rendering, b.processingVersion]);
  const now = new Date().toISOString();
  const existing = await db
    .prepare(
      'SELECT id,slug,current_revision,deleted_at FROM sources WHERE canonical_url=? OR slug=? OR id=?',
    )
    .bind(b.source.url, b.slug, sourceId)
    .all<Head>();
  if (existing.results.some((s) => s.deleted_at)) throw new StoreError('source_deleted');
  if (existing.results.some((s) => s.id !== sourceId || s.slug !== b.slug))
    throw new StoreError('url_or_slug_conflict');
  const head = existing.results[0];
  if (head?.deleted_at) throw new StoreError('source_deleted');
  if (head?.current_revision === revision) return { revision, slug: b.slug, duplicate: true };
  if (head?.current_revision && head.current_revision !== expected)
    throw new StoreError('revision_conflict');
  const guardId = crypto.randomUUID();
  const stmts = [
    db
      .prepare(
        'INSERT INTO sources(id,slug,canonical_url,metadata_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(sourceId, b.slug, b.source.url, JSON.stringify(b.source), now),
    db
      .prepare(
        'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision IS ? AND deleted_at IS NULL)',
      )
      .bind(guardId, sourceId, expected),
    db
      .prepare(
        'INSERT INTO captures(id,source_id,scope,mode,paragraphs_json,permissions_json,metadata_json,captured_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        captureId,
        sourceId,
        b.capture.scope,
        b.capture.mode,
        JSON.stringify(b.capture.paragraphs),
        JSON.stringify(b.capture.permissions),
        JSON.stringify(b.source),
        b.source.capturedAt,
      ),
    db
      .prepare(
        'INSERT INTO renderings(id,capture_id,title,intro,paragraphs_json,processing_version,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        revision,
        captureId,
        b.rendering.title,
        b.rendering.intro,
        JSON.stringify(b.rendering.paragraphs),
        b.processingVersion,
        now,
      ),
  ];
  for (const c of b.rendering.claims)
    stmts.push(
      db
        .prepare('INSERT INTO claims VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(
          `${revision}_${c.id}`,
          revision,
          c.id,
          c.text,
          c.kind,
          JSON.stringify(c.evidence),
          c.caveat,
        ),
    );
  for (const c of b.rendering.concepts) {
    const id = await hash([c.name.normalize('NFKC'), c.meaning.normalize('NFKC')]);
    stmts.push(
      db
        .prepare('INSERT INTO concepts VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id, c.name.normalize('NFKC'), c.meaning.normalize('NFKC')),
    );
    stmts.push(
      db
        .prepare('INSERT INTO rendering_concepts VALUES(?,?) ON CONFLICT DO NOTHING')
        .bind(revision, id),
    );
  }
  for (const [i, q] of b.rendering.questions.entries())
    stmts.push(
      db
        .prepare('INSERT INTO questions VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(`${revision}_q${i}`, revision, q.text, JSON.stringify(q.evidence)),
    );
  if (b.rendering.viewDraft)
    stmts.push(
      db
        .prepare('INSERT INTO view_drafts VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(
          `${revision}_draft`,
          revision,
          b.rendering.viewDraft.text,
          JSON.stringify(b.rendering.viewDraft.evidence),
        ),
    );
  stmts.push(
    db
      .prepare(
        'UPDATE sources SET current_revision=?,metadata_json=? WHERE id=? AND deleted_at IS NULL AND current_revision IS ?',
      )
      .bind(revision, JSON.stringify(b.source), sourceId, expected),
  );
  stmts.push(db.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId));
  let results;
  try {
    results = await db.batch(stmts);
  } catch (error) {
    const current = await db
      .prepare('SELECT current_revision,deleted_at FROM sources WHERE id=?')
      .bind(sourceId)
      .first<Head>();
    if (current?.deleted_at) throw new StoreError('source_deleted');
    if (current?.current_revision === revision) return { revision, slug: b.slug, duplicate: true };
    if (current?.current_revision !== expected) throw new StoreError('revision_conflict');
    throw error;
  }
  if (!results.at(-2)?.meta.changes) throw new StoreError('revision_conflict');
  return { revision, slug: b.slug, duplicate: false };
}
export async function adoptDraft(db: D1Database, id: string, revision: string) {
  const result = await db
    .prepare(
      `INSERT INTO view_revisions(id,draft_id,source_id,rendering_id,text,evidence_json,created_at) SELECT d.id,d.id,s.id,r.id,d.text,d.evidence_json,? FROM view_drafts d JOIN renderings r ON r.id=d.rendering_id JOIN captures c ON c.id=r.capture_id JOIN sources s ON s.id=c.source_id WHERE d.id=? AND r.id=? AND s.current_revision=r.id AND s.deleted_at IS NULL ON CONFLICT(draft_id) DO NOTHING`,
    )
    .bind(new Date().toISOString(), id, revision)
    .run();
  const view = await db
    .prepare('SELECT id,text,created_at FROM view_revisions WHERE draft_id=? AND rendering_id=?')
    .bind(id, revision)
    .first();
  if (!view) throw new StoreError('draft_missing_or_stale');
  return { view, duplicate: !result.meta.changes };
}
export async function deleteSource(db: D1Database, slug: string, expected: string) {
  const head = await db
    .prepare('SELECT id,slug,current_revision,deleted_at FROM sources WHERE slug=?')
    .bind(slug)
    .first<Head>();
  if (!head || head.deleted_at) throw new StoreError('not_found', 404);
  if (head.current_revision !== expected) throw new StoreError('revision_conflict');
  // All operations are conditionally guarded by the same revision. Tombstone is kept for re-import protection.
  const guard =
    'EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision=? AND deleted_at IS NULL)';
  const renderings =
    'SELECT r.id FROM renderings r JOIN captures c ON c.id=r.capture_id WHERE c.source_id=?';
  const stmts = [
    db
      .prepare(`UPDATE view_revisions SET evidence_missing=1 WHERE source_id=? AND ${guard}`)
      .bind(head.id, head.id, expected),
  ];
  for (const table of ['claims', 'questions', 'view_drafts', 'rendering_concepts'])
    stmts.push(
      db
        .prepare(`DELETE FROM ${table} WHERE rendering_id IN (${renderings}) AND ${guard}`)
        .bind(head.id, head.id, expected),
    );
  // Retain usage-only records so deletion cannot reset the day's spending. Remove all private output.
  stmts.push(
    db
      .prepare(
        `UPDATE jobs SET result_json=NULL,error_code='source_deleted',actual_micro_usd=CASE WHEN status IN('queued','reserved') THEN 0 ELSE actual_micro_usd END,status=CASE WHEN status='sending' THEN 'submission_unknown' ELSE 'source_deleted' END WHERE capture_id IN(SELECT id FROM captures WHERE source_id=?) AND ${guard}`,
      )
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(`DELETE FROM editions WHERE source_id=? AND ${guard}`)
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(`DELETE FROM renderings WHERE id IN (${renderings}) AND ${guard}`)
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(`DELETE FROM captures WHERE source_id=? AND ${guard}`)
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(
        'UPDATE sources SET deleted_at=?,current_revision=NULL,metadata_json=? WHERE id=? AND current_revision=? AND deleted_at IS NULL',
      )
      .bind(new Date().toISOString(), '{}', head.id, expected),
  );
  const results = await db.batch(stmts);
  if (!results.at(-1)?.meta.changes) throw new StoreError('revision_conflict');
}
export async function exportRecords(db: D1Database) {
  const result: Record<string, unknown> = { version: 1, exportedAt: new Date().toISOString() };
  for (const table of [
    'sources',
    'captures',
    'renderings',
    'claims',
    'concepts',
    'rendering_concepts',
    'questions',
    'view_drafts',
    'view_revisions',
    'reading_progress',
    'editions',
  ])
    result[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  return result;
}
