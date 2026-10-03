import { z } from 'zod';
import { StoreError } from './storage';

export const viewText = z.string().trim().min(1).max(2000);
export async function viewContexts(db: D1Database, url: string, peers: { sourceId: string }[]) {
  const current = await db
    .prepare('SELECT id FROM sources WHERE canonical_url=?')
    .bind(url)
    .first<{ id: string }>();
  const ids = [...(current ? [current.id] : []), ...peers.map((p) => p.sourceId)];
  if (!ids.length) return [];
  return (
    await db
      .prepare(
        `SELECT v.root_id AS rootId,v.id AS expectedRevision,v.text FROM view_heads h JOIN view_revisions v ON v.id=h.revision_id JOIN view_revisions root ON root.id=v.root_id WHERE root.kind='adoption' AND v.source_id IN(${ids.map(() => '?').join(',')}) ORDER BY v.created_at DESC LIMIT 2`,
      )
      .bind(...ids)
      .all<{ rootId: string; expectedRevision: string; text: string }>()
  ).results;
}
export async function loadViewContexts(db: D1Database, ids: string[]) {
  if (!ids.length) return [];
  return (
    await db
      .prepare(
        `SELECT root_id AS rootId,id AS expectedRevision,text FROM view_revisions WHERE id IN(${ids
          .slice(0, 2)
          .map(() => '?')
          .join(',')})`,
      )
      .bind(...ids.slice(0, 2))
      .all<{ rootId: string; expectedRevision: string; text: string }>()
  ).results;
}
export async function adoptProposal(db: D1Database, id: string, revision: string) {
  const proposal = await db
    .prepare('SELECT * FROM view_proposals WHERE id=?')
    .bind(id)
    .first<{
      root_id: string;
      expected_revision: string;
      text: string;
      evidence_json: string;
      rendering_id: string;
    }>();
  if (!proposal) throw new StoreError('not_found', 404);
  const duplicate = await db
    .prepare('SELECT id FROM view_revisions WHERE proposal_id=?')
    .bind(id)
    .first<{ id: string }>();
  if (duplicate) return { id: duplicate.id, duplicate: true };
  const next = crypto.randomUUID(),
    guard = crypto.randomUUID(),
    now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM view_heads WHERE root_id=? AND revision_id=?) AND EXISTS(SELECT 1 FROM renderings r JOIN captures c ON c.id=r.capture_id JOIN sources s ON s.id=c.source_id WHERE r.id=? AND r.id=? AND s.current_revision=r.id AND s.deleted_at IS NULL)',
        )
        .bind(guard, proposal.root_id, proposal.expected_revision, proposal.rendering_id, revision),
      db
        .prepare(
          "INSERT INTO view_revisions(id,draft_id,source_id,rendering_id,text,evidence_json,created_at,evidence_missing,root_id,parent_id,kind,proposal_id) SELECT ?,NULL,c.source_id,r.id,?,?,?,0,?,?,'edit',? FROM renderings r JOIN captures c ON c.id=r.capture_id WHERE r.id=?",
        )
        .bind(
          next,
          proposal.text,
          proposal.evidence_json,
          now,
          proposal.root_id,
          proposal.expected_revision,
          id,
          revision,
        ),
      db
        .prepare('UPDATE view_heads SET revision_id=? WHERE root_id=? AND revision_id=?')
        .bind(next, proposal.root_id, proposal.expected_revision),
      db.prepare('DELETE FROM write_guards WHERE id=?').bind(guard),
    ]);
  } catch {
    throw new StoreError('revision_conflict');
  }
  return { id: next, duplicate: false };
}
export async function listViews(db: D1Database, sourceId?: string) {
  return (
    await db
      .prepare(
        `SELECT v.id,v.root_id,v.text,v.created_at,v.kind,v.evidence_missing,s.slug FROM view_heads h JOIN view_revisions v ON v.id=h.revision_id JOIN sources s ON s.id=v.source_id ${sourceId ? 'WHERE v.source_id=?' : ''} ORDER BY v.created_at DESC LIMIT 100`,
      )
      .bind(...(sourceId ? [sourceId] : []))
      .all<{
        id: string;
        root_id: string;
        text: string;
        created_at: string;
        kind: 'adoption' | 'edit' | 'note';
        evidence_missing: number;
        slug: string;
      }>()
  ).results;
}
export async function viewHistory(db: D1Database, root: string) {
  const rows = (
    await db
      .prepare(
        'SELECT id,root_id,parent_id,text,kind,evidence_json,evidence_missing,created_at,rendering_id FROM view_revisions WHERE root_id=? ORDER BY created_at,id',
      )
      .bind(root)
      .all()
  ).results;
  if (!rows.length) throw new StoreError('not_found', 404);
  return rows;
}
export async function editView(db: D1Database, root: string, input: unknown) {
  const p = z
    .object({ expectedRevision: z.string().min(1).max(100), text: viewText })
    .strict()
    .parse(input);
  const id = crypto.randomUUID(),
    guard = crypto.randomUUID(),
    now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM view_heads WHERE root_id=? AND revision_id=?)',
        )
        .bind(guard, root, p.expectedRevision),
      db
        .prepare(
          "INSERT INTO view_revisions(id,draft_id,source_id,rendering_id,text,evidence_json,created_at,evidence_missing,root_id,parent_id,kind) SELECT ?,NULL,source_id,rendering_id,?,evidence_json,?,evidence_missing,root_id,id,'edit' FROM view_revisions WHERE id=? AND root_id=?",
        )
        .bind(id, p.text, now, p.expectedRevision, root),
      db
        .prepare('UPDATE view_heads SET revision_id=? WHERE root_id=? AND revision_id=?')
        .bind(id, root, p.expectedRevision),
      db.prepare('DELETE FROM write_guards WHERE id=?').bind(guard),
    ]);
  } catch {
    throw new StoreError('revision_conflict');
  }
  return { id, rootId: root };
}
export async function addNote(db: D1Database, slug: string, input: unknown) {
  const p = z
    .object({ revision: z.string().length(64), text: viewText })
    .strict()
    .parse(input);
  const id = crypto.randomUUID(),
    guard = crypto.randomUUID(),
    now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE slug=? AND current_revision=? AND deleted_at IS NULL)',
        )
        .bind(guard, slug, p.revision),
      db
        .prepare(
          "INSERT INTO view_revisions(id,draft_id,source_id,rendering_id,text,evidence_json,created_at,evidence_missing,root_id,parent_id,kind) SELECT ?,NULL,id,current_revision,?,'[]',?,0,?,NULL,'note' FROM sources WHERE slug=? AND current_revision=? AND deleted_at IS NULL",
        )
        .bind(id, p.text, now, id, slug, p.revision),
      db.prepare('INSERT INTO view_heads(root_id,revision_id) VALUES(?,?)').bind(id, id),
      db.prepare('DELETE FROM write_guards WHERE id=?').bind(guard),
    ]);
  } catch {
    throw new StoreError('revision_conflict');
  }
  return { id, rootId: id };
}
