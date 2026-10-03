import {
  validateBundle,
  type Bundle,
  type Generated,
  type Story,
  type StorySummary,
} from '../shared/model';
import { relationStatements } from './relations';
import { listViews } from './views';

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
  current_revision: string;
  hidden: number;
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
const storySelect = `SELECT s.id,s.slug,s.canonical_url,c.metadata_json,s.current_revision,s.hidden,r.id AS revision,r.title,r.intro,r.paragraphs_json,c.mode,c.scope,c.paragraphs_json AS original_json,c.permissions_json,c.captured_at,p.fraction FROM sources s JOIN renderings r ON r.id=s.current_revision JOIN captures c ON c.id=r.capture_id LEFT JOIN reading_progress p ON p.source_id=s.id WHERE s.deleted_at IS NULL AND s.hidden=0`;
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
    publishedAtBasis: meta.publishedAtBasis,
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
export async function getStory(
  db: D1Database,
  slug: string,
  revision?: string,
): Promise<Story | null> {
  const select = revision
    ? storySelect.replace(
        'JOIN renderings r ON r.id=s.current_revision JOIN captures c ON c.id=r.capture_id',
        'JOIN captures c ON c.source_id=s.id JOIN renderings r ON r.capture_id=c.id',
      )
    : storySelect;
  const row = await db
    .prepare(
      `${select.replace(' AND s.hidden=0', '')} AND s.slug=?${revision ? ' AND r.id=?' : ''}`,
    )
    .bind(slug, ...(revision ? [revision] : []))
    .first<StoryRow>();
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
  const views = await listViews(db, row.id);
  const proposals = (
    await db
      .prepare(
        'SELECT p.*,old.text AS previous_text,EXISTS(SELECT 1 FROM view_revisions v WHERE v.proposal_id=p.id) AS adopted,NOT EXISTS(SELECT 1 FROM view_heads h WHERE h.root_id=p.root_id AND h.revision_id=p.expected_revision) AS stale FROM view_proposals p JOIN view_revisions old ON old.id=p.expected_revision WHERE p.rendering_id=?',
      )
      .bind(row.revision)
      .all<{
        id: string;
        text: string;
        previous_text: string;
        evidence_json: string;
        root_id: string;
        expected_revision: string;
        adopted: number;
        stale: number;
      }>()
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
  const relations = (
    await db
      .prepare(
        `SELECT rel.*,s.slug,r.title FROM relations rel JOIN renderings r ON r.id=rel.to_revision JOIN captures c ON c.id=r.capture_id JOIN sources s ON s.id=c.source_id WHERE rel.from_revision=? AND s.deleted_at IS NULL ORDER BY rel.created_at DESC LIMIT 3`,
      )
      .bind(row.revision)
      .all<{
        id: string;
        slug: string;
        title: string;
        to_revision: string;
        from_claim: string;
        to_claim: string;
        kind: Generated['relations'][number]['kind'];
        reason: string;
        conditions: string;
        from_evidence_json: string;
        to_evidence_json: string;
        independent: number;
      }>()
  ).results;
  const mediaRows = (
    await db
      .prepare(
        'SELECT m.job_id,m.asset_keys_json FROM media_requests m JOIN jobs j ON j.id=m.job_id JOIN renderings r ON r.capture_id=j.capture_id WHERE r.id=? AND m.metadata_json IS NOT NULL',
      )
      .bind(row.revision)
      .all<{ job_id: string; asset_keys_json: string }>()
  ).results;
  return {
    ...summary(row),
    media: mediaRows.flatMap((m) =>
      (JSON.parse(m.asset_keys_json) as Array<{ kind: string; seconds?: number }>).map(
        (a, index) => ({
          url: `/api/media/assets/${m.job_id}/${index}`,
          kind: a.kind,
          ...(a.seconds === undefined ? {} : { seconds: a.seconds }),
        }),
      ),
    ),
    currentRevision: row.current_revision,
    hidden: !!row.hidden,
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
      viewProposal: null,
      relations: [],
    },
    drafts: drafts.map((d) => ({
      id: d.id,
      text: d.text,
      evidence: parse(d.evidence_json),
      adopted: !!d.adopted,
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      text: p.text,
      previousText: p.previous_text,
      evidence: parse(p.evidence_json),
      rootId: p.root_id,
      expectedRevision: p.expected_revision,
      adopted: !!p.adopted,
      stale: !!p.stale,
    })),
    views: views.map((v) => ({
      id: v.id,
      rootId: v.root_id,
      kind: v.kind,
      text: v.text,
      createdAt: v.created_at,
      evidenceMissing: !!v.evidence_missing,
    })),
    connections,
    relations: relations.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      toRevision: r.to_revision,
      fromClaim: r.from_claim,
      toClaim: r.to_claim,
      kind: r.kind,
      reason: r.reason,
      conditions: r.conditions,
      fromEvidence: parse(r.from_evidence_json),
      toEvidence: parse(r.to_evidence_json),
      independent: !!r.independent,
    })),
  };
}
export async function importBundle(
  db: D1Database,
  input: unknown,
  expected: string | null = null,
  jobId?: string,
) {
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
        `INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision IS ? AND deleted_at IS NULL${jobId ? ' AND hidden=0' : ''})${jobId ? " AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='received')" : ''}`,
      )
      .bind(guardId, sourceId, expected, ...(jobId ? [jobId] : [])),
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
  stmts.push(...(await relationStatements(db, revision, sourceId, b.rendering)));
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
  if (b.rendering.viewProposal) {
    const p = b.rendering.viewProposal;
    if (jobId) {
      const context = await db
        .prepare('SELECT view_context_json FROM jobs WHERE id=?')
        .bind(jobId)
        .first<{ view_context_json: string }>();
      if (!JSON.parse(context?.view_context_json || '[]').includes(p.expectedRevision))
        throw new StoreError('invalid_view_proposal', 400);
    }
    const exists = await db
      .prepare('SELECT id FROM view_revisions WHERE id=? AND root_id=?')
      .bind(p.expectedRevision, p.rootId)
      .first();
    if (!exists) throw new StoreError('invalid_view_proposal', 400);
    stmts.push(
      db
        .prepare('INSERT INTO view_proposals VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(
          `${revision}_proposal`,
          revision,
          p.rootId,
          p.expectedRevision,
          p.text,
          JSON.stringify(p.evidence),
        ),
    );
  }
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
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO view_revisions(id,draft_id,source_id,rendering_id,text,evidence_json,created_at,root_id,kind) SELECT d.id,d.id,s.id,r.id,d.text,d.evidence_json,?,d.id,'adoption' FROM view_drafts d JOIN renderings r ON r.id=d.rendering_id JOIN captures c ON c.id=r.capture_id JOIN sources s ON s.id=c.source_id WHERE d.id=? AND r.id=? AND s.current_revision=r.id AND s.deleted_at IS NULL ON CONFLICT(draft_id) DO NOTHING`,
      )
      .bind(new Date().toISOString(), id, revision),
    db
      .prepare(
        'INSERT INTO view_heads(root_id,revision_id) SELECT id,id FROM view_revisions WHERE draft_id=? ON CONFLICT DO NOTHING',
      )
      .bind(id),
  ]);
  const view = await db
    .prepare('SELECT id,text,created_at FROM view_revisions WHERE draft_id=? AND rendering_id=?')
    .bind(id, revision)
    .first();
  if (!view) throw new StoreError('draft_missing_or_stale');
  return { view, duplicate: !results[0].meta.changes };
}
export async function deleteSource(db: D1Database, slug: string, expected: string | null) {
  const head = await db
    .prepare('SELECT id,slug,current_revision,deleted_at FROM sources WHERE slug=?')
    .bind(slug)
    .first<Head>();
  if (!head || head.deleted_at) throw new StoreError('not_found', 404);
  if (head.current_revision !== expected) throw new StoreError('revision_conflict');
  // All operations are conditionally guarded by the same revision. Tombstone is kept for re-import protection.
  const guard =
    'EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision IS ? AND deleted_at IS NULL)';
  const renderings =
    'SELECT r.id FROM renderings r JOIN captures c ON c.id=r.capture_id WHERE c.source_id=?';
  const stmts = [
    db
      .prepare(`UPDATE view_revisions SET evidence_missing=1 WHERE source_id=? AND ${guard}`)
      .bind(head.id, head.id, expected),
  ];
  stmts.push(
    db
      .prepare(
        `UPDATE jobs SET error_code='source_deleted',actual_micro_usd=CASE WHEN status IN('queued','reserved') THEN 0 ELSE actual_micro_usd END,status=CASE WHEN status='sending' THEN 'submission_unknown' ELSE 'source_deleted' END WHERE id IN(SELECT job_id FROM investment_runs i WHERE EXISTS(SELECT 1 FROM json_each(i.snapshot_json) ref WHERE json_extract(ref.value,'$.slug')=?)) AND ${guard}`,
      )
      .bind(slug, head.id, expected),
    db
      .prepare(
        `UPDATE investment_runs SET output_json=NULL WHERE EXISTS(SELECT 1 FROM json_each(investment_runs.snapshot_json) ref WHERE json_extract(ref.value,'$.slug')=?) AND ${guard}`,
      )
      .bind(slug, head.id, expected),
  );
  stmts.push(
    db
      .prepare(
        `DELETE FROM relations WHERE (from_revision IN (${renderings}) OR to_revision IN (${renderings})) AND ${guard}`,
      )
      .bind(head.id, head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE jobs SET result_json=NULL,error_code='source_deleted',actual_micro_usd=CASE WHEN status IN('queued','reserved') THEN 0 ELSE actual_micro_usd END,status=CASE WHEN status='sending' THEN 'submission_unknown' ELSE 'source_deleted' END WHERE id IN(SELECT job_id FROM media_requests WHERE source_id=?) AND ${guard}`,
      )
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE job_parts SET result_json=NULL WHERE job_id IN(SELECT job_id FROM media_requests WHERE source_id=?) AND ${guard}`,
      )
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(`UPDATE media_requests SET metadata_json=NULL WHERE source_id=? AND ${guard}`)
      .bind(head.id, head.id, expected),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE feed_candidates SET content_json=NULL,status='deleted',reason='source_deleted' WHERE canonical_url=? AND ${guard}`,
      )
      .bind(
        (await db
          .prepare('SELECT canonical_url FROM sources WHERE id=?')
          .bind(head.id)
          .first<{ canonical_url: string }>())!.canonical_url,
        head.id,
        expected,
      ),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE jobs SET result_json=NULL,error_code='peer_source_deleted',status=CASE WHEN status='sending' THEN 'submission_unknown' WHEN status='completed' THEN status ELSE 'failed' END WHERE EXISTS(SELECT 1 FROM json_each(jobs.peer_revisions_json) peer WHERE peer.value IN (${renderings})) AND ${guard}`,
      )
      .bind(head.id, head.id, expected),
  );
  // Peer context stores only revision IDs; removal invalidates it when the next step reloads evidence.
  for (const table of [
    'claims',
    'questions',
    'view_drafts',
    'view_proposals',
    'rendering_concepts',
    'listening_progress',
  ])
    stmts.push(
      db
        .prepare(`DELETE FROM ${table} WHERE rendering_id IN (${renderings}) AND ${guard}`)
        .bind(head.id, head.id, expected),
    );
  // Retain usage-only records so deletion cannot reset the day's spending. Remove all private output.
  stmts.push(
    db
      .prepare(
        `UPDATE job_parts SET result_json=NULL WHERE job_id IN(SELECT id FROM jobs WHERE capture_id IN(SELECT id FROM captures WHERE source_id=?) OR EXISTS(SELECT 1 FROM json_each(jobs.peer_revisions_json) peer WHERE peer.value IN (${renderings}))) AND ${guard}`,
      )
      .bind(head.id, head.id, head.id, expected),
  );
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
        'UPDATE sources SET deleted_at=?,current_revision=NULL,metadata_json=? WHERE id=? AND current_revision IS ? AND deleted_at IS NULL',
      )
      .bind(new Date().toISOString(), '{}', head.id, expected),
  );
  const results = await db.batch(stmts);
  if (!results.at(-1)?.meta.changes) throw new StoreError('revision_conflict');
}
export async function setVisibility(
  db: D1Database,
  slug: string,
  expected: string | null,
  hidden: boolean,
) {
  const result = await db
    .prepare(
      'UPDATE sources SET hidden=? WHERE slug=? AND current_revision IS ? AND deleted_at IS NULL',
    )
    .bind(Number(hidden), slug, expected)
    .run();
  if (!result.meta.changes) throw new StoreError('revision_conflict');
  return { hidden };
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
    'view_heads',
    'view_proposals',
    'reading_progress',
    'listening_progress',
    'editions',
    'source_registry',
    'feed_candidates',
    'daily_runs',
    'daily_candidates',
    'relations',
    'media_requests',
  ])
    result[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  return result;
}
