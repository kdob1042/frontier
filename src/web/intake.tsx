import { useState } from 'react';
import { prepareMedia } from './prepare-media';
interface Source {
  id: string;
  name: string;
  enabled: number;
  policy_json: string;
}
interface IntakeResult {
  status: string;
  kind: 'image' | 'audio' | 'video' | 'pdf';
  assetUrl: string;
  error?: string;
}
const messages: Record<string, string> = {
  article_acquisition_not_permitted: 'この媒体の記事本文の取り込み範囲を設定してください。',
  media_acquisition_not_permitted:
    'この媒体の画像・音声・動画・字幕・PDFの取り込み範囲を設定してください。',
  external_processing_not_permitted: '原資料のAI読み取りが、この媒体の設定で許可されていません。',
  document_type_not_supported:
    'このURLから対応する本文やファイルを取得できません。記事の公開ページ、直接のファイルURL、または配信字幕を指定してください。',
  article_root_missing_or_ambiguous:
    'この媒体の本文の場所を特定できません。媒体設定の本文範囲を確認してください。',
  capture_too_large_split_required:
    '本文が保存上限を超えています。分割した原資料を指定してください。',
  asset_too_large: '原資料がサイズ上限を超えています。ファイルは12MB、PDFは2MBまでです。',
  media_duration_limit:
    '音声・動画の直接取り込みは3分までです。長い動画は配信字幕を指定してください。',
  source_deleted: '削除済みの原資料は取り込めません。',
  source_hidden: '非表示の原資料です。再表示してから取り込んでください。',
  revision_conflict: '保存済みの日本語版があります。更新対象の版を指定して取り込んでください。',
  vision_budget_not_configured: '画像・PDFの読み取り用モデルと費用上限の設定待ちです。',
  audio_rate_not_configured: '音声の文字起こし用の料金設定待ちです。',
  ai_not_configured: 'AIのモデル・接続・費用上限の設定待ちです。',
  ai_disabled: 'AIの処理が停止されています。',
};
const readableError = (message: string) =>
  messages[message] ||
  (/^[a-z0-9_:]+$/.test(message)
    ? '取り込みを完了できませんでした。媒体の設定と処理履歴を確認してください。'
    : message);
export function IntakeForm({ sources, onSaved }: { sources: Source[]; onSaved: () => void }) {
  const [url, setUrl] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function post(path: string, body: unknown) {
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      data = (await r.json()) as IntakeResult;
    if (!r.ok) throw new Error(data.error || '取り込みに失敗しました。');
    return data;
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('公開範囲を取得しています…');
    try {
      const host = new URL(url).hostname,
        source = sources.find((s) => {
          try {
            return s.enabled && JSON.parse(s.policy_json).allowedHosts?.includes(host);
          } catch {
            return false;
          }
        });
      if (!source) throw new Error('このURLの媒体を、下の利用条件設定で有効にしてください。');
      let result = await post('/api/admin/intake', { registryId: source.id, url });
      if (result.status === 'prepare_media') {
        setMessage('原資料を読み取っています…');
        const response = await fetch(
          `/api/admin/intake/asset?registryId=${encodeURIComponent(source.id)}&url=${encodeURIComponent(result.assetUrl)}`,
        );
        if (!response.ok)
          throw new Error(
            ((await response.json()) as { error?: string }).error || '原資料を取得できません。',
          );
        const assets = await prepareMedia(await response.blob(), result.kind);
        result = await post('/api/admin/media', {
          registryId: source.id,
          url,
          kind: result.kind,
          assets,
        });
      }
      setMessage(
        result.status === 'captured'
          ? '原資料を保存しました。日本語化はAI設定待ちです。'
          : '取り込みジョブを開始しました。処理状況は下の履歴に表示されます。',
      );
      setUrl('');
      onSaved();
    } catch (error) {
      setMessage(readableError((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="detail-body" onSubmit={(e) => void submit(e)}>
      <p className="quiet">記事・画像・音声・動画・PDF・配信字幕の公開URLから取り込みます。</p>
      <label>
        原資料のURL
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
      </label>
      <button disabled={busy}>{busy ? '読み取っています…' : '取り込む'}</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
