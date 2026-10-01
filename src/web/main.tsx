import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { demoStory } from '../shared/demo';
import { kindLabels, modeLabels, relationLabels } from '../shared/labels';
import type { Story, StorySummary } from '../shared/model';
import './style.css';
import { Listen } from './listen';

const demo = location.pathname.startsWith('/demo');
const base = demo ? '/demo' : '';
const path = location.pathname.slice(base.length) || '/';
const date = (d: string) =>
  new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }).format(
    new Date(d),
  );
const messages: Record<string, string> = {
  authentication_required: '認証が必要です。Cloudflare Accessのログインを確認してください。',
  not_found: 'この記録は見つかりません。',
  ai_not_configured: '原資料は保存しました。AI処理にはモデル・キー・予算の設定が必要です。',
  revision_conflict: '新しい版があります。読み直してから操作してください。',
  source_deleted: '削除した原資料は再取り込みできません。',
  invalid_record: '原文・日本語・根拠の対応を確認してください。',
  invalid_input: '入力の形式を確認してください。',
  budget_stopped: '設定した予算上限で停止しました。',
  submission_unknown_do_not_retry:
    '送信成否が未確定のため再送できません。費用の予約を保持しています。',
  same_day_retry_required:
    '分割結果の再開は同じJST日付に限ります。既存結果と使用量は保持されています。',
  retry_limit: 'この呼び出しの再試行上限に達しました。',
  source_policy_changed: '媒体の利用条件が変わったため、外部AI処理を止めています。',
};
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok)
    throw new Error(
      messages[data.error || ''] || '処理できませんでした。時間をおいて再度お試しください。',
    );
  return data;
}
function getDemo(): Story {
  const s = demoStory();
  try {
    s.progress = Number(localStorage.getItem('frontier-demo-progress') || 0);
    if (localStorage.getItem('frontier-demo-adopted')) {
      s.drafts[0].adopted = true;
      s.views = [
        {
          id: 'demo-view',
          rootId: 'demo-view',
          kind: 'adoption',
          text: s.drafts[0].text,
          createdAt: '2026-10-01T00:00:00Z',
          evidenceMissing: false,
        },
      ];
    }
  } catch {
    /* Storage may be disabled. Reading still works. */
  }
  return s;
}
function useLoad<T>(key: string, loader: () => Promise<T>) {
  const [state, set] = useState<{ data?: T; error?: string }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    set({});
    loader()
      .then((data) => {
        if (active) set({ data });
      })
      .catch((e) => {
        if (active) set({ error: e.message });
      });
    return () => {
      active = false;
    };
  }, [key, retry]);
  return { ...state, retry: () => setRetry((n) => n + 1) };
}
function Waiting({ error, retry }: { error?: string; retry: () => void }) {
  return error ? (
    <div className="state" role="alert">
      <p>{error}</p>
      <button onClick={retry}>再読み込み</button>
    </div>
  ) : (
    <p className="state" role="status">
      記録を開いています…
    </p>
  );
}
function Metadata({ story }: { story: StorySummary }) {
  return (
    <p className="metadata">
      {story.publisher}
      <span>／</span>
      {date(story.publishedAt)}
      <span>／</span>
      {story.minutes}分
    </p>
  );
}
function Home() {
  type HomeData = {
    recommended: StorySummary | null;
    recent: StorySummary[];
    edition?: { day: string; status: string } | null;
  };
  const state = useLoad('home', () =>
    demo
      ? Promise.resolve({ recommended: getDemo(), recent: [] } as HomeData)
      : api<HomeData>('/api/home'),
  );
  if (!state.data) return <Waiting {...state} />;
  const { recommended: s, recent } = state.data;
  return (
    <>
      <p className="eyebrow">
        {demo
          ? 'SAMPLE STORY'
          : state.data.edition?.day ===
              new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
            ? 'TODAY’S STORY'
            : 'SAVED STORY'}
      </p>
      {s ? (
        <a
          className="cover"
          href={`${base}/stories/${s.slug}${demo ? '' : `?revision=${s.revision}`}`}
        >
          <h1>{s.title}</h1>
          <p className="intro">{s.intro}</p>
          <Metadata story={s} />
          <span className="read">
            {s.progress > 0 && s.progress < 0.95 ? '続きを読む' : '読む'}{' '}
            <span aria-hidden="true">↗</span>
          </span>
        </a>
      ) : (
        <section className="empty">
          <h1>
            世界の変化を、
            <br />
            ひとつずつ。
          </h1>
          <p>
            まだ日本語の記録はありません。
            <br />
            取り込んだ記事と知見が、ここに残ります。
          </p>
          <a href="/demo">自作のデモ記事を読む ↗</a>
        </section>
      )}
      {state.data.edition &&
        state.data.edition.day !==
          new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) && (
          <p className="quiet">
            今日は新しい推薦がありません。前回の記録 · {state.data.edition.day}
          </p>
        )}
      {recent.length > 0 && (
        <section className="recent">
          <h2>これまでの記録</h2>
          {recent.map((s) => (
            <a className="record-row" href={`${base}/stories/${s.slug}`} key={s.slug}>
              <span>{s.title}</span>
              <small>{s.publisher}</small>
            </a>
          ))}
        </section>
      )}
    </>
  );
}
function useReadingProgress(story: Story | undefined) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!story || story.currentRevision !== story.revision) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: number | undefined;
    let restored = false;
    const maximum = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, Math.round(story.progress * maximum()));
      restored = true;
    });
    const save = () => {
      if (pending === undefined) return;
      const fraction = pending;
      pending = undefined;
      if (demo) {
        try {
          localStorage.setItem('frontier-demo-progress', String(fraction));
        } catch {
          setFailed(true);
        }
        return;
      }
      void api(`/api/stories/${story.slug}/progress`, {
        method: 'PUT',
        keepalive: true,
        body: JSON.stringify({ fraction, updatedAt: Date.now() }),
      })
        .then(() => setFailed(false))
        .catch(() => setFailed(true));
    };
    const onScroll = () => {
      if (!restored) return;
      pending = maximum() ? Math.min(1, window.scrollY / maximum()) : 1;
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    const hide = () => {
      clearTimeout(timer);
      save();
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('pagehide', hide);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      save();
      removeEventListener('scroll', onScroll);
      removeEventListener('pagehide', hide);
    };
  }, [story?.slug, story?.revision]);
  return failed;
}
function Reader({ slug }: { slug: string }) {
  const state = useLoad(slug, () =>
    demo
      ? Promise.resolve(getDemo())
      : api<Story>(`/api/stories/${encodeURIComponent(slug)}${location.search}`),
  );
  const failed = useReadingProgress(state.data);
  const sourceDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!state.data || !location.hash.startsWith('#source-')) return;
    if (sourceDetails.current) sourceDetails.current.open = true;
    const frame = requestAnimationFrame(() =>
      document.getElementById(location.hash.slice(1))?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, [state.data?.revision]);
  const [adoptionError, setError] = useState('');
  const [adopted, setAdopted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  if (!state.data) return <Waiting {...state} />;
  const s = state.data;
  const current = s.currentRevision === s.revision;
  const source = (ids: string[]) =>
    ids.map((id) => (
      <a
        className="evidence"
        href={`#source-${id}`}
        key={id}
        onClick={() => {
          if (sourceDetails.current) sourceDetails.current.open = true;
        }}
      >
        {id}
      </a>
    ));
  async function adopt(id: string) {
    setBusy(true);
    setError('');
    try {
      if (demo) {
        localStorage.setItem('frontier-demo-adopted', 'true');
      } else {
        await api('/api/views/adopt', {
          method: 'POST',
          body: JSON.stringify({ draftId: id, revision: s.revision }),
        });
      }
      setAdopted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveNote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/stories/${s.slug}/notes`, {
        method: 'POST',
        body: JSON.stringify({ revision: s.revision, text: note }),
      });
      setNoteSaved(true);
      setNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function adoptChange(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/views/proposals/${id}/adopt`, {
        method: 'POST',
        body: JSON.stringify({ revision: s.revision }),
      });
      state.retry();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="reader">
      <p className="eyebrow">{modeLabels[s.mode]}</p>
      {!current && (
        <p className="quiet">
          参照された過去の版です。<a href={`${base}/stories/${s.slug}`}>現在の版を読む</a>
        </p>
      )}
      {s.hidden && <p className="quiet">ホームと記事一覧では非表示にした記録です。</p>}
      <h1>{s.title}</h1>
      <p className="lede">{s.intro}</p>
      <Metadata story={s} />
      <p className="source-line">
        原著：{s.source.author} ·{' '}
        <a href={s.source.url} target="_blank" rel="noreferrer">
          原文を読む ↗
        </a>
      </p>
      <Listen key={s.revision} story={s} demo={demo} />
      <p className="scope">
        {s.capture.scope}
        {s.mode !== 'link_only' && (
          <>
            <br />
            機械翻訳・AI抽出。記事の主張は独立した検証を意味しません。
          </>
        )}
      </p>
      {s.mode === 'link_only' ? (
        <p className="state">日本語本文は未取得です。原文リンクからご覧ください。</p>
      ) : (
        <div className="prose">
          {s.rendering.paragraphs.map((p, i) => (
            <p key={`${p.sourceId}-${i}`}>{p.text}</p>
          ))}
        </div>
      )}
      {s.rendering.claims.length > 0 && (
        <section className="harvest">
          <p className="eyebrow">AIが抽出した知見</p>
          <h2>今回の発見</h2>
          {s.rendering.claims.map((c) => (
            <div className="insight" key={c.id}>
              <p>{c.text}</p>
              <small>
                {kindLabels[c.kind]}
                {source(c.evidence)}
              </small>
              {c.caveat && <p className="caveat">{c.caveat}</p>}
            </div>
          ))}
        </section>
      )}
      {s.relations.length > 0 && (
        <section className="harvest">
          <h2>過去とのつながり</h2>
          {s.relations.map((r, i) => (
            <details key={r.id} open={i === 0}>
              <summary>
                {relationLabels[r.kind]} · {r.reason}
              </summary>
              <div className="detail-body">
                <p>
                  <a href={`${base}/stories/${r.slug}?revision=${r.toRevision}`}>{r.title}</a>
                </p>
                <p className="quiet">AIによる関係の解釈。{r.conditions}</p>
                <p>
                  今回の根拠 {source(r.fromEvidence)} · 過去の根拠{' '}
                  {r.toEvidence.map((id) => (
                    <a
                      className="evidence"
                      key={id}
                      href={`${base}/stories/${r.slug}?revision=${r.toRevision}#source-${id}`}
                    >
                      {id}
                    </a>
                  ))}
                </p>
                {!r.independent && (
                  <p className="quiet">
                    原資料の独立性は未確認です。独立した裏付けとして数えていません。
                  </p>
                )}
              </div>
            </details>
          ))}
        </section>
      )}
      {!s.relations.length && s.connections.length > 0 && (
        <section className="harvest">
          <h2>過去とのつながり</h2>
          <p className="quiet">
            同じ意味の概念を含む記録です。支持・反証や因果の判定はまだ行っていません。
          </p>
          {s.connections.map((c) => (
            <p key={c.slug}>
              <a href={`${base}/stories/${c.slug}`}>{c.title}</a>
              <small className="quiet"> · {c.concept}</small>
            </p>
          ))}
        </section>
      )}
      {s.rendering.questions.length > 0 && (
        <section className="harvest">
          <h2>残る問い</h2>
          {s.rendering.questions.map((q, i) => (
            <p key={i}>
              {q.text} {source(q.evidence)}
            </p>
          ))}
        </section>
      )}
      {(s.drafts.length > 0 || s.views.length > 0 || s.proposals.length > 0) && (
        <section className="harvest">
          <h2>見方への影響</h2>
          {s.proposals.map((p) => (
            <details className="view-draft" key={p.id}>
              <summary>見方の改訂案 · {p.text}</summary>
              <div className="detail-body">
                <p className="quiet">
                  AIが提案した新しい文章です。明示採用するまで、既存の見方は変わりません。
                </p>
                <p>
                  <small className="quiet">参照していた本人の文章</small>
                  <br />
                  {p.previousText}
                </p>
                <p>{source(p.evidence)}</p>
                {p.adopted ? (
                  <p role="status">本人の新しい版として採用済み</p>
                ) : p.stale || !current ? (
                  <p className="quiet">参照後に版が変わったため、この案は採用できません。</p>
                ) : (
                  <button disabled={busy} onClick={() => void adoptChange(p.id)}>
                    この案で自分の見方を更新
                  </button>
                )}
                {adoptionError && <p role="alert">{adoptionError}</p>}
              </div>
            </details>
          ))}
          {s.drafts.map((d) => (
            <details key={d.id} className="view-draft">
              <summary>{d.text}</summary>
              <div className="detail-body">
                <p className="quiet">
                  AIが用意した案です。採用するまで、あなたの見方にはなりません。
                </p>
                <p>{source(d.evidence)}</p>
                {d.adopted || adopted ? (
                  <p role="status">自分の見方として保存済み{demo ? '（デモ内）' : ''}</p>
                ) : !current ? (
                  <p className="quiet">
                    過去の版の案です。採用する場合は現在の版をご確認ください。
                  </p>
                ) : (
                  <button disabled={busy} onClick={() => void adopt(d.id)}>
                    {busy ? '保存しています…' : '自分の見方にする'}
                  </button>
                )}
                {adoptionError && <p role="alert">{adoptionError}</p>}
              </div>
            </details>
          ))}
          {s.views.map((v) => (
            <p className="adopted" key={v.id}>
              <small>
                あなたの{v.kind === 'note' ? 'メモ' : '見方'} · {date(v.createdAt)}
              </small>
              <br />
              {v.text}
              {v.evidenceMissing && <small>原資料は削除されています。</small>}
            </p>
          ))}
        </section>
      )}
      {!demo && current && (
        <details className="reader-note">
          <summary>ひと言を残す・訂正を記録する</summary>
          <form className="detail-body" onSubmit={(e) => void saveNote(e)}>
            <label>
              あなたのメモ
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setNoteSaved(false);
                }}
              />
            </label>
            <button disabled={busy}>メモを残す</button>
            {noteSaved && <p role="status">あなたの文章として保存しました。</p>}
            {adoptionError && <p role="alert">{adoptionError}</p>}
          </form>
        </details>
      )}
      <details className="original" ref={sourceDetails}>
        <summary>原文との対応・取得情報</summary>
        <div className="detail-body">
          <p className="quiet">
            原題：{s.source.title}
            <br />
            取得：{date(s.capturedAt)}
            {s.source.updatedAt && (
              <>
                <br />
                原文更新：{date(s.source.updatedAt)}
              </>
            )}
            <br />
            利用範囲：{s.capture.permissions.basis}
          </p>
          {s.capture.paragraphs.map((p) => (
            <p className="source-paragraph" id={`source-${p.id}`} key={p.id}>
              <small>{p.id}</small>
              <br />
              {p.text}
            </p>
          ))}
          {!s.capture.paragraphs.length && (
            <p>
              原文本文は保存していません。
              <a href={s.source.url} target="_blank" rel="noreferrer">
                原典へ ↗
              </a>
            </p>
          )}
        </div>
      </details>
      {failed && (
        <p className="quiet" role="status">
          読んだ位置を保存できませんでした。次のスクロールで再試行します。
        </p>
      )}
    </article>
  );
}
type ViewRow = {
  id: string;
  root_id: string;
  text: string;
  slug: string;
  evidence_missing: number;
};
function ViewEditor({ view, onSaved }: { view: ViewRow; onSaved: () => void }) {
  const [text, setText] = useState(view.text),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [history, setHistory] =
    useState<Array<{ id: string; text: string; created_at: string; rendering_id: string }>>();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/views/${view.root_id}`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision: view.id, text }),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !history)
          void api<{ revisions: NonNullable<typeof history> }>(`/api/views/${view.root_id}/history`)
            .then((r) => setHistory(r.revisions))
            .catch((e) => setError(e.message));
      }}
    >
      <summary>自分の文章を編集・履歴を読む</summary>
      <form className="detail-body" onSubmit={(e) => void save(e)}>
        <label>
          あなたの文章
          <textarea
            required
            maxLength={2000}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button disabled={busy}>新しい版として保存</button>
        {error && <p role="alert">{error}</p>}
        {!!history && (
          <details>
            <summary>これまでの文章</summary>
            <div className="detail-body">
              {history.map((h) => (
                <p key={h.id}>
                  <small>{date(h.created_at)}</small>
                  <br />
                  {h.text}
                  {!view.evidence_missing && (
                    <>
                      <br />
                      <a
                        className="quiet"
                        href={`${base}/stories/${view.slug}?revision=${h.rendering_id}`}
                      >
                        当時の原文と日本語版を読む
                      </a>
                    </>
                  )}
                </p>
              ))}
            </div>
          </details>
        )}
      </form>
    </details>
  );
}
function Archive() {
  const [query, setQuery] = useState('');
  const [stable, setStable] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setStable(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const state = useLoad(stable, () =>
    demo
      ? Promise.resolve({ stories: [getDemo()].filter((s) => JSON.stringify(s).includes(stable)) })
      : api<{ stories: StorySummary[] }>(`/api/stories?q=${encodeURIComponent(stable)}`),
  );
  const views = useLoad('views', () =>
    demo
      ? Promise.resolve({
          views: getDemo().views.map((v) => ({
            id: v.id,
            root_id: v.rootId,
            text: v.text,
            slug: getDemo().slug,
            evidence_missing: 0,
          })),
        })
      : api<{ views: ViewRow[] }>('/api/views'),
  );
  return (
    <>
      <p className="eyebrow">YOUR RECORDS</p>
      <h1 className="small-title">記録</h1>
      <label className="search">
        記事・知見・自分の見方を検索
        <input
          type="search"
          value={query}
          placeholder="気になった言葉で探す"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {!state.data ? (
        <Waiting {...state} />
      ) : state.data.stories.length ? (
        <div className="records">
          {state.data.stories.map((s) => (
            <a className="record-row" href={`${base}/stories/${s.slug}`} key={s.slug}>
              <span>{s.title}</span>
              <small>
                {s.publisher} · {modeLabels[s.mode]} · {date(s.publishedAt)}
              </small>
            </a>
          ))}
        </div>
      ) : (
        <p className="state">{stable ? '一致する記録はありません。' : '記録はまだありません。'}</p>
      )}
      {!!views.data?.views.length && (
        <section className="harvest">
          <h2>自分の見方</h2>
          {views.data.views
            .filter((v) => v.text.includes(stable))
            .map((v, i) => (
              <div key={i}>
                <p>
                  {v.evidence_missing ? (
                    <>
                      {v.text}
                      <small className="quiet"> · 原資料は削除済み</small>
                    </>
                  ) : (
                    <a href={`${base}/stories/${v.slug}`}>{v.text}</a>
                  )}
                </p>
                {!demo && <ViewEditor view={v} onSaved={views.retry} />}
              </div>
            ))}
        </section>
      )}
    </>
  );
}
function Admin() {
  type Status = {
    environment: string;
    aiEnabled: boolean;
    aiConfigured: boolean;
    dailyEnabled: boolean;
    records: Array<{ slug: string; revision: string | null; title: string; hidden: number }>;
    dailyRuns: Array<{
      day: string;
      status: string;
      stage: string;
      reason: string | null;
      candidate_count: number;
      selected_count: number;
      completed_count: number;
    }>;
    spending: Array<{ budget_day: string | null; micro_usd: number }>;
    sources: Array<{
      id: string;
      name: string;
      enabled: number;
      reason: string;
      feed_url: string | null;
      policy_json: string;
      error_code: string | null;
      last_success_at: string | null;
    }>;
    jobs: Array<{ id: string; status: string; error_code: string | null }>;
  };
  const state = useLoad('admin', () => api<Status>('/api/admin/status'));
  const [input, setInput] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [policyInput, setPolicyInput] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [recordSlug, setRecordSlug] = useState(''),
    [recordAction, setRecordAction] = useState('hide');
  async function manageRecord(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    const record = state.data!.records.find((r) => r.slug === recordSlug)!;
    try {
      if (recordAction === 'delete')
        await api(`/api/admin/stories/${recordSlug}`, {
          method: 'DELETE',
          headers: { 'If-Match': record.revision || 'pending' },
        });
      else
        await api(`/api/admin/stories/${recordSlug}/visibility`, {
          method: 'PUT',
          body: JSON.stringify({ revision: record.revision, hidden: recordAction === 'hide' }),
        });
      setMessage('記録の設定を変更しました。');
      setRecordSlug('');
      state.retry();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function daily(resume = false) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ status: string }>('/api/admin/daily', {
        method: 'POST',
        body: JSON.stringify({ resume }),
      });
      setMessage(`日次処理：${result.status}`);
      state.retry();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function savePolicy(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api(`/api/admin/sources/${encodeURIComponent(sourceId)}`, {
        method: 'PUT',
        body: JSON.stringify(JSON.parse(policyInput)),
      });
      setMessage('媒体設定を保存しました。');
      state.retry();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function jobAction(id: string, action: 'stop' | 'retry') {
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ status: string }>(`/api/admin/jobs/${id}/${action}`, {
        method: 'POST',
        body: '{}',
      });
      setMessage(`処理：${result.status}`);
      state.retry();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const parsed = JSON.parse(input);
      if (parsed.rendering) {
        const result = await api<{ slug: string }>('/api/admin/import', {
          method: 'POST',
          body: JSON.stringify(parsed),
        });
        setMessage(`保存しました：${result.slug}`);
      } else {
        const capture = await api<{ captureId: string }>('/api/admin/captures', {
          method: 'POST',
          body: JSON.stringify(parsed),
        });
        await api('/api/admin/jobs', {
          method: 'POST',
          body: JSON.stringify({ captureId: capture.captureId, expectedRevision: null }),
        });
        setMessage('原資料を保存し、日本語化ジョブを開始しました。');
      }
      setInput('');
      state.retry();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="eyebrow">OWNER</p>
      <h1 className="small-title">管理</h1>
      {!state.data ? (
        <Waiting {...state} />
      ) : (
        <>
          <p className="quiet">
            AI処理：{state.data.aiEnabled ? '有効' : '停止中'} · {state.data.environment}
          </p>
          <details>
            <summary>取り込み・日本語化</summary>
            <form className="detail-body" onSubmit={(e) => void submit(e)}>
              <p className="quiet">
                利用可能な原資料、または日本語化済みの記録をJSONで取り込みます。自動収集は、許可確認済みのフィードと日次設定が揃ったときに実行します。
              </p>
              <label>
                資料・記録JSON
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  required
                  rows={8}
                />
              </label>
              <button disabled={busy}>{busy ? '保存しています…' : '取り込む'}</button>
            </form>
          </details>
          <details>
            <summary>記録の表示・削除</summary>
            <form className="detail-body" onSubmit={(e) => void manageRecord(e)}>
              <p className="quiet">
                非表示の記録は自動収集で一覧へ戻りません。削除しても本人の文章は履歴とともに残します。
              </p>
              <label>
                記録
                <select required value={recordSlug} onChange={(e) => setRecordSlug(e.target.value)}>
                  <option value="">記録を選択</option>
                  {state.data.records.map((r) => (
                    <option key={r.slug} value={r.slug}>
                      {r.hidden ? '非表示 · ' : ''}
                      {r.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                変更
                <select value={recordAction} onChange={(e) => setRecordAction(e.target.value)}>
                  <option value="hide">ホーム・記事一覧で非表示</option>
                  <option value="show">再び表示する</option>
                  <option value="delete">原資料とAI記録を削除する</option>
                </select>
              </label>
              <button disabled={busy || !recordSlug}>変更を保存</button>
            </form>
          </details>
          <details>
            <summary>媒体の利用条件と状態</summary>
            <div className="detail-body">
              {state.data.sources.map((s) => (
                <p key={s.id}>
                  {s.name}
                  <br />
                  <small className="quiet">
                    {s.enabled ? '有効' : '保留'} · {s.reason}
                    {s.error_code && ` · ${s.error_code}`}
                    {s.last_success_at && ` · 最終取得 ${date(s.last_success_at)}`}
                  </small>
                </p>
              ))}
              <details>
                <summary>確認済みの媒体設定を変更</summary>
                <form className="detail-body" onSubmit={(e) => void savePolicy(e)}>
                  <p className="quiet">
                    取得・保存・AI送信・翻訳の許可と有効期限を個別に指定します。設定形式はREADMEを参照してください。
                  </p>
                  <label>
                    媒体
                    <select
                      aria-label="媒体"
                      required
                      value={sourceId}
                      onChange={(e) => {
                        setSourceId(e.target.value);
                        const s = state.data!.sources.find((s) => s.id === e.target.value);
                        if (s)
                          setPolicyInput(
                            JSON.stringify(
                              {
                                enabled: !!s.enabled,
                                feedUrl: s.feed_url,
                                policy:
                                  typeof JSON.parse(s.policy_json).acquire === 'boolean'
                                    ? JSON.parse(s.policy_json)
                                    : null,
                                reason: s.reason,
                              },
                              null,
                              2,
                            ),
                          );
                      }}
                    >
                      <option value="">媒体を選択</option>
                      {state.data.sources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    確認内容JSON
                    <textarea
                      required
                      rows={8}
                      value={policyInput}
                      onChange={(e) => setPolicyInput(e.target.value)}
                    />
                  </label>
                  <button disabled={busy}>設定を保存</button>
                </form>
              </details>
            </div>
          </details>
          <details>
            <summary>日次処理と使用量</summary>
            <div className="detail-body">
              <p className="quiet">
                自動実行：{state.data.dailyEnabled ? '有効' : '停止中'} ·
                候補10本／日本語化2本／推薦1本が上限です。
              </p>
              {state.data.dailyRuns.map((r) => (
                <p key={r.day}>
                  {r.day} · {r.status}
                  <br />
                  <small className="quiet">
                    {r.stage} · {r.reason} · 候補{r.candidate_count}／選定{r.selected_count}／完了
                    {r.completed_count}
                  </small>
                </p>
              ))}
              {state.data.spending
                .filter((s) => s.budget_day)
                .map((s) => (
                  <p className="quiet" key={s.budget_day}>
                    {s.budget_day} · ${(s.micro_usd / 1000000).toFixed(4)}（未確定の予約分を含む）
                  </p>
                ))}
              <button
                disabled={busy}
                onClick={() =>
                  void daily(
                    !!state.data?.dailyRuns.some(
                      (r) =>
                        r.day ===
                          new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) &&
                        r.status !== 'completed',
                    ),
                  )
                }
              >
                {state.data.dailyRuns.some(
                  (r) =>
                    r.day === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) &&
                    r.status !== 'completed',
                )
                  ? '未完了の処理を再開'
                  : '今日の処理を開始'}
              </button>
            </div>
          </details>
          <details>
            <summary>処理の状態</summary>
            <div className="detail-body">
              {state.data.jobs.length ? (
                state.data.jobs.map((j) => (
                  <details key={j.id}>
                    <summary>
                      {j.status}
                      {j.error_code && ` · ${j.error_code}`}
                    </summary>
                    <div className="detail-body">
                      <small className="quiet">{j.id.slice(0, 12)}</small>
                      {['queued', 'reserved', 'sending', 'received'].includes(j.status) ? (
                        <p>
                          <button disabled={busy} onClick={() => void jobAction(j.id, 'stop')}>
                            処理を停止
                          </button>
                        </p>
                      ) : ['failed', 'budget_stopped', 'cancelled'].includes(j.status) ? (
                        <p>
                          <button disabled={busy} onClick={() => void jobAction(j.id, 'retry')}>
                            安全に再開できるか確認して再試行
                          </button>
                        </p>
                      ) : j.status === 'submission_unknown' ? (
                        <p className="quiet">
                          送信成否が未確定のため、自動で再送しません。予算の予約分を保持しています。
                        </p>
                      ) : null}
                    </div>
                  </details>
                ))
              ) : (
                <p>処理履歴はありません。</p>
              )}
            </div>
          </details>
          <p className="quiet">
            <a href="/api/export">出典と履歴をJSONで書き出す ↗</a>
            <br />
            <a href="/api/export?format=markdown">Markdownで書き出す ↗</a>
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
function App() {
  const match = path.match(/^\/stories\/([a-zA-Z0-9_-]+)$/);
  return (
    <div className="shell">
      <header>
        <a className="brand" href={base || '/'}>
          FRONTIER<span>世界の変化を、知見に。</span>
        </a>
      </header>
      {demo && (
        <aside className="demo-note">
          自作の架空事例によるデモ · 実際の記録には保存されません。
        </aside>
      )}
      <main>
        {match ? (
          <Reader slug={match[1]} />
        ) : path === '/archive' ? (
          <Archive />
        ) : path === '/admin' && !demo ? (
          <Admin />
        ) : path === '/' ? (
          <Home />
        ) : (
          <section className="state">
            <h1>ページがありません。</h1>
            <a href={base || '/'}>ホームへ</a>
          </section>
        )}
      </main>
      <footer>
        <a href={path === '/archive' ? base || '/' : `${base}/archive`}>
          {path === '/archive' ? 'ホーム' : '記録'}
        </a>
        {!demo && <a href="/admin">管理</a>}
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
