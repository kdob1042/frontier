import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { demoStory } from '../shared/demo';
import { kindLabels, modeLabels, type Story, type StorySummary } from '../shared/model';
import './style.css';

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
      <p className="eyebrow">{demo ? 'SAMPLE STORY' : 'TODAY’S STORY'}</p>
      {s ? (
        <a className="cover" href={`${base}/stories/${s.slug}`}>
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
          <p className="quiet">前回の記録 · {state.data.edition.day}</p>
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
    if (!story) return;
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
    demo ? Promise.resolve(getDemo()) : api<Story>(`/api/stories/${encodeURIComponent(slug)}`),
  );
  const failed = useReadingProgress(state.data);
  const sourceDetails = useRef<HTMLDetailsElement>(null);
  const [adoptionError, setError] = useState('');
  const [adopted, setAdopted] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!state.data) return <Waiting {...state} />;
  const s = state.data;
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
  return (
    <article className="reader">
      <p className="eyebrow">{modeLabels[s.mode]}</p>
      <h1>{s.title}</h1>
      <p className="lede">{s.intro}</p>
      <Metadata story={s} />
      <p className="source-line">
        原著：{s.source.author} ·{' '}
        <a href={s.source.url} target="_blank" rel="noreferrer">
          原文を読む ↗
        </a>
      </p>
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
      {s.connections.length > 0 && (
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
      {(s.drafts.length > 0 || s.views.length > 0) && (
        <section className="harvest">
          <h2>見方への影響</h2>
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
              <small>あなたが採用した見方 · {date(v.createdAt)}</small>
              <br />
              {v.text}
              {v.evidenceMissing && <small>原資料は削除されています。</small>}
            </p>
          ))}
        </section>
      )}
      <details className="original" ref={sourceDetails}>
        <summary>原文との対応・取得情報</summary>
        <div className="detail-body">
          <p className="quiet">
            原題：{s.source.title}
            <br />
            取得：{date(s.capturedAt)}
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
            text: v.text,
            slug: getDemo().slug,
            evidence_missing: 0,
          })),
        })
      : api<{ views: Array<{ text: string; slug: string; evidence_missing: number }> }>(
          '/api/views',
        ),
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
              <p key={i}>
                {v.evidence_missing ? (
                  <>
                    {v.text}
                    <small className="quiet"> · 原資料は削除済み</small>
                  </>
                ) : (
                  <a href={`${base}/stories/${v.slug}`}>{v.text}</a>
                )}
              </p>
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
    sources: Array<{ id: string; name: string; enabled: number; reason: string }>;
    jobs: Array<{ id: string; status: string; error_code: string | null }>;
  };
  const state = useLoad('admin', () => api<Status>('/api/admin/status'));
  const [input, setInput] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
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
                利用可能な原資料、または日本語化済みの記録をJSONで取り込みます。通常の自動収集は次の実装段階です。
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
            <summary>媒体の利用条件と状態</summary>
            <div className="detail-body">
              {state.data.sources.map((s) => (
                <p key={s.id}>
                  {s.name}
                  <br />
                  <small className="quiet">
                    {s.enabled ? '有効' : '保留'} · {s.reason}
                  </small>
                </p>
              ))}
            </div>
          </details>
          <details>
            <summary>処理の状態</summary>
            <div className="detail-body">
              {state.data.jobs.length ? (
                state.data.jobs.map((j) => (
                  <p key={j.id}>
                    {j.status}
                    {j.error_code && ` · ${j.error_code}`}
                    <br />
                    <small className="quiet">{j.id.slice(0, 12)}</small>
                  </p>
                ))
              ) : (
                <p>処理履歴はありません。</p>
              )}
            </div>
          </details>
          <p className="quiet">
            <a href="/api/export">出典と履歴をJSONで書き出す ↗</a>
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
