import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Story } from '../shared/model';
import { makeSpeechPlan } from '../shared/speech';

type Status = 'closed' | 'playing' | 'paused' | 'ended';
export function Listen({ story, demo }: { story: Story; demo: boolean }) {
  const plan = useMemo(() => makeSpeechPlan(story), [story]);
  const supported =
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [rate, setRate] = useState(1);
  const [status, setStatus] = useState<Status>('closed');
  const [chunk, setChunk] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const position = useRef(0);
  const token = useRef(0);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = useRef(false);
  const touched = useRef(false);
  const lastTimestamp = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const storageKey = `frontier-demo-listening-${story.revision}`;

  useEffect(() => {
    if (!supported) return;
    const update = () =>
      setVoices(
        speechSynthesis.getVoices().filter((v) => /^ja(?:-|_|$)/i.test(v.lang) && v.localService),
      );
    update();
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, [supported]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      let value = 0;
      try {
        if (demo) value = Number(localStorage.getItem(storageKey) || 0);
        else {
          const r = await fetch(
            `/api/stories/${encodeURIComponent(story.slug)}/listening?revision=${story.revision}`,
          );
          if (!r.ok) throw new Error('load_failed');
          value = ((await r.json()) as { chunk: number }).chunk;
        }
      } catch {
        if (active) setSaveFailed(true);
      }
      if (!active) return;
      position.current = Number.isInteger(value) && value >= 0 && value <= plan.length ? value : 0;
      setChunk(position.current);
      setReady(true);
    };
    void load();
    return () => {
      active = false;
    };
  }, [story.slug, story.revision, demo, storageKey, plan.length]);

  function save() {
    if (!touched.current) return;
    const value = position.current;
    if (demo) {
      try {
        localStorage.setItem(storageKey, String(value));
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
      return;
    }
    lastTimestamp.current = Math.max(Date.now(), lastTimestamp.current + 1);
    void fetch(`/api/stories/${encodeURIComponent(story.slug)}/listening`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: story.revision,
        chunk: value,
        updatedAt: lastTimestamp.current,
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('save_failed');
        setSaveFailed(false);
      })
      .catch(() => setSaveFailed(true));
  }
  function cancel() {
    token.current += 1;
    playing.current = false;
    clearTimeout(watchdog.current);
    if (supported) speechSynthesis.cancel();
    utterance.current = null;
  }
  function pause() {
    if (!playing.current) return;
    cancel();
    save();
    setStatus('paused');
  }
  useEffect(() => {
    const hide = () => {
      if (document.hidden) pause();
    };
    const leave = () => {
      cancel();
      save();
    };
    document.addEventListener('visibilitychange', hide);
    addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      removeEventListener('pagehide', leave);
      cancel();
      save();
    };
  }, [story.slug, story.revision]);

  useEffect(() => {
    if (!voices.length) pause();
  }, [voices.length]);

  function play(index = position.current) {
    const voice =
      voices.find((v) => v.voiceURI === voiceId) || voices.find((v) => v.default) || voices[0];
    if (!voice || !ready) return;
    cancel();
    const run = token.current;
    setError('');
    touched.current = true;
    playing.current = true;
    setStatus('playing');
    const speak = (at: number) => {
      if (run !== token.current) return;
      position.current = at;
      setChunk(at);
      save();
      if (at >= plan.length) {
        playing.current = false;
        setStatus('ended');
        return;
      }
      const u = new SpeechSynthesisUtterance(plan[at].text);
      utterance.current = u;
      u.lang = 'ja-JP';
      u.voice = voice;
      u.rate = rate;
      const fail = () => {
        if (run !== token.current || utterance.current !== u) return;
        cancel();
        save();
        setStatus('paused');
        setError('音声が止まりました。再生するとこの文から再開します。');
      };
      u.onend = () => {
        if (run !== token.current || utterance.current !== u) return;
        utterance.current = null;
        clearTimeout(watchdog.current);
        speak(at + 1);
      };
      u.onerror = fail;
      watchdog.current = setTimeout(fail, 60000);
      try {
        speechSynthesis.speak(u);
      } catch {
        fail();
      }
    };
    speak(index >= plan.length ? 0 : index);
  }
  function close() {
    cancel();
    save();
    setStatus('closed');
    setError('');
    if (details.current) details.current.open = false;
    requestAnimationFrame(() => trigger.current?.focus());
  }
  if (!plan.length) return null;
  if (!supported || !voices.length)
    return <p className="quiet">この端末で利用できる日本語の読み上げ音声がありません。</p>;
  if (!ready) return <p className="quiet">音声の保存位置を確認しています…</p>;
  return (
    <section
      className="listen"
      aria-label="記事の読み上げ"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && status !== 'closed') {
          e.preventDefault();
          close();
        }
      }}
    >
      {status === 'closed' ? (
        <button ref={trigger} className="listen-trigger" onClick={() => play()}>
          聴く
        </button>
      ) : (
        <>
          <div className="listen-controls">
            <button onClick={() => (status === 'playing' ? pause() : play())}>
              {status === 'playing' ? '一時停止' : status === 'ended' ? 'もう一度聴く' : '再生'}
            </button>
            <details ref={details}>
              <summary>詳細</summary>
              <p className="quiet">
                端末内の日本語音声で読み上げます。画面を離れると一時停止し、再開時は文の先頭から聴けます。
              </p>
              <label>
                読み上げ速度
                <select
                  aria-label="読み上げ速度"
                  value={rate}
                  onChange={(e) => {
                    pause();
                    setRate(Number(e.target.value));
                  }}
                >
                  {[0.75, 1, 1.25, 1.5].map((r) => (
                    <option value={r} key={r}>
                      {r}倍
                    </option>
                  ))}
                </select>
              </label>
              <label>
                日本語音声
                <select
                  aria-label="日本語音声"
                  value={voiceId || (voices.find((v) => v.default) || voices[0]).voiceURI}
                  onChange={(e) => {
                    pause();
                    setVoiceId(e.target.value);
                  }}
                >
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                聴く場所
                <select
                  aria-label="聴く場所"
                  value={Math.min(chunk, plan.length - 1)}
                  onChange={(e) => {
                    pause();
                    touched.current = true;
                    position.current = Number(e.target.value);
                    setChunk(position.current);
                    save();
                    setStatus('paused');
                  }}
                >
                  {plan.map((p, i) =>
                    i === 0 || p.section !== plan[i - 1].section ? (
                      <option key={i} value={i}>
                        {p.section}
                      </option>
                    ) : i === Math.min(chunk, plan.length - 1) ? (
                      <option key={i} value={i}>
                        {p.section}の続き
                      </option>
                    ) : null,
                  )}
                </select>
              </label>
              <button className="listen-trigger" onClick={close}>
                読み上げを終了
              </button>
            </details>
          </div>
          <p className="quiet">
            {status === 'ended'
              ? '読み上げが終わりました。'
              : `${plan[Math.min(chunk, plan.length - 1)].section} · ${chunk + 1}/${plan.length}`}
          </p>
        </>
      )}
      {error && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
      {saveFailed && (
        <p className="quiet" role="status">
          音声の位置を保存・取得できませんでした。記事はそのまま読めます。
        </p>
      )}
    </section>
  );
}
