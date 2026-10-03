import { useEffect, useState } from 'react';
import type { InvestmentState } from '../shared/investment';
export function Investment() {
  const [state, setState] = useState<InvestmentState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    const r = await fetch('/api/investment');
    if (!r.ok) throw new Error('論点を読み込めませんでした。');
    setState(await r.json());
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function start() {
    setConfirm(false);
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/investment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, requestId: crypto.randomUUID() }),
      });
      if (!r.ok) throw new Error('実行できませんでした。AI設定と対象記事を確認してください。');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '実行状況を確認してください。');
    } finally {
      setBusy(false);
    }
  }
  const active =
    busy ||
    ['queued', 'reserved', 'sending', 'submission_unknown', 'received'].includes(
      state?.run?.status || '',
    );
  return (
    <>
      <h1>投資論点</h1>
      <p>
        未使用の記事から、利益への影響と反証条件を持つ仮説を最大10本抽出します。抽出成功時に使った記事は次回から除外します。
      </p>
      {state && (
        <p>
          対象 {state.selected} 記事（分析可能 {state.eligible} ／使用済み {state.used}{' '}
          ／その他対象外 {state.excluded}）
        </p>
      )}
      <button
        disabled={!state?.aiConfigured || !state.selected || active}
        onClick={() => setConfirm(true)}
      >
        AIで論点を抽出
      </button>
      {!state?.aiConfigured && state && <p>AIのモデル・キー・予算設定が必要です。</p>}
      {state && state.selected === 0 && (
        <p>
          未使用の記事がありません。使用済みの記事は除外しています。本文の根拠とAI処理許可がある新しい記事を追加してください。
        </p>
      )}
      {confirm && (
        <section role="dialog" aria-modal="true" aria-labelledby="investment-confirm">
          <h2 id="investment-confirm">AIを実行しますか？</h2>
          <p>{state?.selected}記事の取得範囲を外部AIへ送信します。設定済みのAPI予算を使います。</p>
          <button autoFocus style={{ minHeight: 48, padding: '12px 24px' }} onClick={start}>
            はい、実行する
          </button>{' '}
          <button onClick={() => setConfirm(false)}>戻る</button>
        </section>
      )}
      {busy && <p role="status">AIが投資論点を抽出しています…</p>}
      {error && <p role="alert">{error}</p>}
      {state?.run && (
        <>
          <p>
            {state.run.execution === 'chatgpt_import'
              ? 'ChatGPTで抽出・取り込み'
              : 'アプリのAIで抽出'}{' '}
            ／実行状態：{state.run.status}
            {state.run.error ? ` (${state.run.error})` : ''}
          </p>
          <button disabled={busy} onClick={() => refresh().catch((e) => setError(e.message))}>
            状況を更新
          </button>
          {state.run.stale && (
            <p>根拠記事が更新・非表示・削除されたため、この結果は表示できません。</p>
          )}
          {state.run.status === 'submission_unknown' && (
            <p>送信成否が未確定です。二重課金を避けるため自動再実行しません。</p>
          )}
          {state.run.result && (
            <>
              <p>AIが提案した仮説です。自分の見解としては保存されません。</p>
              <p>{state.run.result.limitations}</p>
              {state.run.result.theses.length === 0 && (
                <p>根拠のある投資論点を抽出できませんでした。</p>
              )}
              {state.run.result.theses.map((t, i) => (
                <section key={i}>
                  <h2>
                    {i + 1}. {t.hypothesis}
                  </h2>
                  <p>{t.mechanism}</p>
                  <dl>
                    <dt>恩恵候補</dt>
                    <dd>{t.beneficiaries}</dd>
                    <dt>逆風</dt>
                    <dd>{t.headwinds}</dd>
                    <dt>反証条件</dt>
                    <dd>{t.counterEvidence}</dd>
                    <dt>確認指標</dt>
                    <dd>{t.indicators}</dd>
                    <dt>時間軸</dt>
                    <dd>{t.horizon}</dd>
                  </dl>
                  <details>
                    <summary>根拠の記事・段落</summary>
                    {t.evidence.map((e, j) => {
                      const a = state.run!.articles.find((a) => a.revision === e.revision);
                      const p = a?.paragraphs.find((p) => p.id === e.paragraphId);
                      return (
                        <div key={j}>
                          {a ? (
                            <>
                              <a href={`/stories/${a.slug}?revision=${a.revision}`}>{a.title}</a>
                              <p>
                                {a.publisher} ／ {a.mode} ／ {a.scope}
                              </p>
                              <p>
                                {p?.basis === 'ai_summary' && (
                                  <strong>保存済みAI要約（原文未検証）／</strong>
                                )}
                                {p?.text}
                              </p>
                              <a href={a.url} target="_blank" rel="noreferrer">
                                原典へ
                              </a>
                            </>
                          ) : (
                            <p>根拠を読み込めませんでした。</p>
                          )}
                        </div>
                      );
                    })}
                  </details>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}
