import type { Generated } from '../shared/model';
import { hash, StoreError } from './storage';
import { externalSourceStillPermitted } from './feeds';

export interface Peer {
  revision: string;
  sourceId: string;
  url: string;
  title: string;
  claims: Generated['claims'];
  paragraphs: { id: string; text: string }[];
}
export async function loadPeers(db: D1Database, revisions: string[]): Promise<Peer[]> {
  const peers: Peer[] = [];
  for (const revision of revisions.slice(0, 3)) {
    const row = await db
      .prepare(
        'SELECT s.id AS source_id,s.canonical_url,r.title,c.paragraphs_json,c.permissions_json FROM renderings r JOIN captures c ON c.id=r.capture_id JOIN sources s ON s.id=c.source_id WHERE r.id=? AND s.current_revision=r.id AND s.deleted_at IS NULL AND s.hidden=0',
      )
      .bind(revision)
      .first<{
        source_id: string;
        canonical_url: string;
        title: string;
        paragraphs_json: string;
        permissions_json: string;
      }>();
    if (!row || !JSON.parse(row.permissions_json).ai) continue;
    try {
      await externalSourceStillPermitted(db, row.canonical_url);
    } catch {
      continue;
    }
    const claims = (
      await db
        .prepare(
          'SELECT local_id,text,kind,evidence_json,caveat FROM claims WHERE rendering_id=? ORDER BY rowid LIMIT 3',
        )
        .bind(revision)
        .all<{
          local_id: string;
          text: string;
          kind: Generated['claims'][number]['kind'];
          evidence_json: string;
          caveat: string;
        }>()
    ).results;
    const paragraphs = JSON.parse(row.paragraphs_json) as Peer['paragraphs'];
    const selected = claims
      .map((c) => ({
        id: c.local_id,
        text: c.text,
        kind: c.kind,
        evidence: JSON.parse(c.evidence_json) as string[],
        caveat: c.caveat,
      }))
      .filter((c) =>
        c.evidence.every((id) => paragraphs.some((p) => p.id === id && p.text.length <= 1800)),
      );
    if (!selected.length) continue;
    const ids = new Set(selected.flatMap((c) => c.evidence));
    const included = paragraphs.filter((p) => ids.has(p.id));
    if (included.reduce((n, p) => n + p.text.length, 0) > 5000) continue;
    peers.push({
      revision,
      sourceId: row.source_id,
      url: row.canonical_url,
      title: row.title,
      claims: selected,
      paragraphs: included,
    });
  }
  return peers;
}
export async function choosePeerRevisions(db: D1Database, url: string) {
  // A bounded recent pool is a candidate set, not evidence that any relation exists.
  const rows = (
    await db
      .prepare(
        'SELECT s.current_revision AS revision FROM sources s JOIN claims c ON c.rendering_id=s.current_revision WHERE s.deleted_at IS NULL AND s.hidden=0 AND s.canonical_url<>? GROUP BY s.id ORDER BY s.created_at DESC LIMIT 12',
      )
      .bind(url)
      .all<{ revision: string }>()
  ).results;
  const result: string[] = [];
  for (const row of rows)
    if ((await loadPeers(db, [row.revision])).length) {
      result.push(row.revision);
      if (result.length === 3) break;
    }
  return result;
}
export async function relationStatements(
  db: D1Database,
  revision: string,
  sourceId: string,
  generated: Generated,
) {
  const stmts: D1PreparedStatement[] = [];
  const peers = await loadPeers(
    db,
    generated.relations.map((r) => r.toRevision),
  );
  for (const r of generated.relations) {
    const peer = peers.find((p) => p.revision === r.toRevision);
    const mine = generated.claims.find((c) => c.id === r.fromClaim);
    const theirs = peer?.claims.find((c) => c.id === r.toClaim);
    if (
      !peer ||
      peer.sourceId === sourceId ||
      !mine ||
      !theirs ||
      r.fromEvidence.some((e) => !mine.evidence.includes(e)) ||
      r.toEvidence.some((e) => !theirs.evidence.includes(e))
    )
      throw new StoreError('relation_missing_or_stale', 400);
    const same = await db
      .prepare(
        'SELECT 1 AS found FROM feed_candidates a JOIN feed_candidates b ON a.fingerprint=b.fingerprint WHERE a.canonical_url=(SELECT canonical_url FROM sources WHERE id=?) AND b.canonical_url=? LIMIT 1',
      )
      .bind(sourceId, peer.url)
      .first();
    // Unchecked lineage is never labelled independent. Even separate URLs can repeat one announcement.
    const independent = false;
    const guard = crypto.randomUUID();
    stmts.push(
      db
        .prepare(
          'INSERT INTO write_guards(id,valid) SELECT ?,EXISTS(SELECT 1 FROM sources WHERE id=? AND current_revision=? AND deleted_at IS NULL)',
        )
        .bind(guard, peer.sourceId, peer.revision),
    );
    const conditions = same
      ? `${r.conditions} 同じ原資料の可能性があるため、独立した裏付けとして数えません。`
      : r.conditions;
    stmts.push(
      db
        .prepare('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(
          await hash([revision, r]),
          revision,
          r.toRevision,
          r.fromClaim,
          r.toClaim,
          r.kind,
          r.reason,
          conditions,
          JSON.stringify(r.fromEvidence),
          JSON.stringify(r.toEvidence),
          Number(independent),
          new Date().toISOString(),
        ),
    );
    stmts.push(db.prepare('DELETE FROM write_guards WHERE id=?').bind(guard));
  }
  return stmts;
}
