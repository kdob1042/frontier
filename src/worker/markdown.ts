import { getStory, listStories } from './storage';
import { kindLabels, modeLabels, relationLabels } from '../shared/model';
import { viewHistory, listViews } from './views';
import { originLabels, originLink, timeLabel } from '../shared/media';

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]#!|])/g, '\\$1');
export async function exportMarkdown(db: D1Database) {
  const lines = ['# FRONTIERの記録', `書き出し：${new Date().toISOString()}`, ''];
  const rows = await listStories(db);
  for (const row of rows) {
    const s = await getStory(db, row.slug);
    if (!s) continue;
    lines.push(
      `## ${escape(s.title)}`,
      '',
      `${escape(s.source.publisher)} · ${escape(s.source.author)} · ${s.source.publishedAt}${s.source.publishedAtBasis === 'capture_time' ? ' 取得（公開日不明）' : ''}`,
      `[原典](${s.source.url}) · ${modeLabels[s.mode]}`,
      `原文取得：${s.capturedAt} · 日本語版：${s.revision}`,
      `取得範囲：${escape(s.capture.scope)}`,
      `利用条件：${escape(s.capture.permissions.basis)}`,
      '',
      escape(s.intro),
      '',
    );
    for (const p of s.rendering.paragraphs)
      lines.push(escape(p.text), `根拠段落：${p.sourceId}`, '');
    if (s.rendering.claims.length) lines.push('### AIが抽出した知見', '');
    for (const c of s.rendering.claims)
      lines.push(
        `- ${escape(c.text)}（${kindLabels[c.kind]}／${c.evidence.join(', ')}）`,
        escape(c.caveat),
      );
    if (s.relations.length) lines.push('', '### AIによる記事間の関係', '');
    for (const r of s.relations)
      lines.push(
        `- ${relationLabels[r.kind]}：[${escape(r.title)}](/stories/${r.slug}?revision=${r.toRevision}) · ${escape(r.reason)}`,
        `  条件：${escape(r.conditions)} · 原資料の独立性：${r.independent ? '確認済み' : '未確認'}`,
        `  今回 ${s.revision}/${r.fromClaim}/${r.fromEvidence.join(',')} ↔ 過去 ${r.toRevision}/${r.toClaim}/${r.toEvidence.join(',')}`,
      );
    if (s.rendering.questions.length) lines.push('', '### 残る問い', '');
    for (const q of s.rendering.questions)
      lines.push(`- ${escape(q.text)}（${q.evidence.join(', ')}）`);
    if (s.drafts.length) lines.push('', '### AIの見方案（本人の文章とは別）', '');
    for (const d of s.drafts)
      lines.push(
        `- ${escape(d.text)} · ${d.adopted ? '本人が明示採用済み' : '未採用'} · ${d.evidence.join(', ')}`,
      );
    if (s.proposals.length) lines.push('', '### 既存の見方へのAI改訂案', '');
    for (const p of s.proposals)
      lines.push(
        `参照本人版：${p.rootId}/${p.expectedRevision}`,
        `以前：${escape(p.previousText)}`,
        `改訂案：${escape(p.text)} · ${p.adopted ? '明示採用済み' : p.stale ? '参照版が変わったため採用不可' : '未採用'} · ${p.evidence.join(', ')}`,
      );
    if (s.capture.permissions.store && s.capture.paragraphs.length) {
      lines.push('', '### 保存した原文・媒体の読み取り', '');
      for (const p of s.capture.paragraphs)
        lines.push(
          `**${p.id}**`,
          ...(p.origin
            ? [
                `[${originLabels[p.origin.method]}${p.origin.startSeconds === undefined ? '' : ` ${timeLabel(p.origin.startSeconds)}`}${p.origin.page === undefined ? '' : ` ${p.origin.page}ページ`}](${originLink(p.origin)})`,
              ]
            : []),
          ...escape(p.text)
            .split('\n')
            .map((line) => `> ${line}`),
          '',
        );
    }
  }
  lines.push('', '## 本人の見方・メモと履歴', '');
  for (const v of await listViews(db)) {
    lines.push(
      `### ${v.root_id}`,
      '',
      `原資料：${v.slug} · ${v.evidence_missing ? '原資料は削除済み' : '保存中'}`,
      '',
    );
    for (const history of await viewHistory(db, v.root_id)) {
      const r = history as {
        id: string;
        parent_id: string | null;
        created_at: string;
        kind: string;
        text: string;
        rendering_id: string;
      };
      lines.push(
        `版：${r.id} · 前版：${r.parent_id || 'なし'} · ${r.created_at} · ${r.kind}`,
        `参照日本語版：${r.rendering_id}`,
        escape(r.text),
        '',
      );
    }
  }
  lines.push(
    'JSON書き出しとD1バックアップは全履歴を含みます。このMarkdownの記事一覧は最新100件です。',
  );
  return lines.join('\n');
}
