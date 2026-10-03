import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { demoBundle } from '../src/shared/demo.ts';
import { withServer, request } from './server.mjs';
await withServer(8796, async (origin) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? {
          executablePath: process.env.BROWSER_EXECUTABLE,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-zygote',
            '--single-process',
            '--in-process-gpu',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
          ],
        }
      : {}),
  });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const writes = [];
  page.on('request', (r) => {
    if (!['GET', 'HEAD'].includes(r.method())) writes.push(r.url());
  });
  try {
    await mkdir('artifacts', { recursive: true });
    await page.goto(origin);
    await expect(page.getByText('まだ日本語の記録はありません。')).toBeVisible();
    await page.screenshot({ path: 'artifacts/mobile-empty.png', fullPage: true });
    await request(origin, '/api/admin/import', { method: 'POST', body: demoBundle });
    await page.reload();
    await expect(page.locator('.cover')).toBeVisible();
    await expect(page.locator('main button:visible')).toHaveCount(0);
    await expect(page.locator('main a.cover')).toHaveCount(1);
    await page.screenshot({ path: 'artifacts/mobile-home.png', fullPage: true });
    await page.locator('.cover').click();
    await expect(page.getByRole('heading', { name: demoBundle.rendering.title })).toBeVisible();
    await expect(page.getByRole('button', { name: '自分の見方にする' })).not.toBeVisible();
    await page.screenshot({ path: 'artifacts/mobile-reader.png', fullPage: true });
    await page.locator('.evidence').first().click();
    await expect(page.locator('.original')).toHaveAttribute('open', '');
    await expect(page.locator('#source-p1')).toBeVisible();
    await page.locator('.view-draft summary').click();
    await expect(page.getByRole('button', { name: '自分の見方にする' })).toBeVisible();
    await expect(page.locator('main button:visible')).toHaveCount(1);
    await page.screenshot({ path: 'artifacts/mobile-view-draft.png', fullPage: true });
    await page.getByRole('button', { name: '自分の見方にする' }).click();
    await expect(page.getByText('自分の見方として保存済み', { exact: true })).toBeVisible();
    await page.reload();
    await page.locator('.view-draft summary').click();
    await expect(page.getByText('自分の見方として保存済み', { exact: true })).toBeVisible();
    await page.locator('footer a').filter({ hasText: '記録' }).click();
    await page.getByRole('searchbox').fill('製造業');
    await expect(page.locator('.record-row')).toHaveCount(1);
    await page.screenshot({ path: 'artifacts/mobile-archive.png', fullPage: true });
    await page.getByRole('searchbox').fill('存在しない言葉');
    await expect(page.getByText('一致する記録はありません。')).toBeVisible();
    await page.goto(`${origin}/demo`);
    await expect(page.getByText('自作の架空事例によるデモ', { exact: false })).toBeVisible();
    await page.goto(`${origin}/stories/${demoBundle.slug}`);
    await page.evaluate(() => scrollTo(0, 500));
    await page.waitForTimeout(900);
    await page.reload();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(350);
    // Owner notes and edits are explicit writes and never trigger inference.
    await page.locator('.reader-note summary').click();
    await page.getByLabel('あなたのメモ').fill('読者本人のメモを残す');
    await page.getByRole('button', { name: 'メモを残す', exact: true }).click();
    await expect(page.getByText('あなたの文章として保存しました。')).toBeVisible();
    await page.goto(`${origin}/archive`);
    const personal = page
      .locator('section.harvest > div')
      .filter({ hasText: demoBundle.rendering.viewDraft.text });
    await personal.getByText('自分の文章を編集・履歴を読む').click();
    await personal.getByLabel('あなたの文章').fill('本人が編集した見方');
    const [editResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/views/') && r.request().method() === 'PUT',
      ),
      personal.getByRole('button', { name: '新しい版として保存' }).click(),
    ]);
    assert.equal(editResponse.status(), 200);
    await expect(page.getByRole('link', { name: '本人が編集した見方', exact: true })).toBeVisible();
    const views = await (await request(origin, '/api/views')).json();
    const view = views.views.find((v) => v.text === '本人が編集した見方');
    assert.ok(view, 'owner edit must be persisted before using its revision');
    const original = await (await request(origin, `/api/stories/${demoBundle.slug}`)).json();
    const connected = structuredClone(demoBundle);
    connected.slug = 'connections-fixture';
    connected.source.url = 'https://example.com/connections-fixture';
    connected.rendering.title = '記事間の関係と見方の改訂を確認する';
    connected.rendering.viewDraft = null;
    connected.rendering.relations = [
      {
        toRevision: original.revision,
        fromClaim: 'c1',
        toClaim: 'c1',
        kind: 'analogous_to',
        reason: '工程学習の仕組みを比べる',
        conditions: '自作の架空事例。独立した実証ではない。',
        fromEvidence: ['p1'],
        toEvidence: ['p1'],
      },
    ];
    connected.rendering.viewProposal = {
      rootId: view.root_id,
      expectedRevision: view.id,
      text: '条件を限定して更新する本人の見方案',
      evidence: ['p1'],
    };
    const imported = await request(origin, '/api/admin/import', {
      method: 'POST',
      body: connected,
    });
    assert.equal(imported.status, 200);
    await page.goto(`${origin}/stories/${connected.slug}`);
    await expect(page.getByText('過去とのつながり', { exact: true })).toBeVisible();
    const priorLink = page.locator(`a.evidence[href*="revision=${original.revision}"]`);
    await priorLink.click();
    await expect(page.locator('.original')).toHaveAttribute('open', '');
    await expect(page.locator('#source-p1')).toBeVisible();
    await page.goto(`${origin}/stories/${connected.slug}`);
    await page.locator('.view-draft summary').click();
    await expect(page.getByRole('button', { name: 'この案で自分の見方を更新' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/mobile-connections.png', fullPage: true });
    await page.getByRole('button', { name: 'この案で自分の見方を更新' }).click();
    await expect(page.locator('.adopted')).toContainText('条件を限定して更新する本人の見方案');
    await page.goto(`${origin}/admin`);
    await page.getByText('媒体の利用条件と状態', { exact: true }).click();
    await page.getByText('確認済みの媒体設定を変更', { exact: true }).click();
    await page.getByLabel('媒体', { exact: true }).selectOption('contrary');
    await expect(page.getByLabel('確認内容JSON')).toHaveValue(/"enabled": false/);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: 'artifacts/mobile-admin.png', fullPage: true });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin);
      await expect(page.locator('.cover')).toBeVisible();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: `artifacts/${width === 390 ? 'mobile' : 'desktop'}-home.png`,
        fullPage: true,
      });
      await page.locator('.cover').click();
      await expect(page.locator('.prose')).toBeVisible();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (width === 1280)
        await page.screenshot({ path: 'artifacts/desktop-reader.png', fullPage: true });
    }
    // Deterministic speech adapter tests control/cancellation only; no real voice quality claim.
    const audioContext = context;
    await page.setViewportSize({ width: 390, height: 844 });
    await audioContext.addInitScript(() => {
      class Utterance {
        constructor(text) {
          this.text = text;
        }
      }
      class Synth extends EventTarget {
        calls = [];
        current = null;
        canceled = null;
        cancels = 0;
        voices = [
          {
            voiceURI: 'fixture-ja',
            name: '検証用日本語音声',
            lang: 'ja-JP',
            localService: true,
            default: true,
          },
        ];
        getVoices() {
          return this.voices;
        }
        speak(u) {
          this.current = u;
          this.calls.push({ text: u.text, rate: u.rate, voice: u.voice.voiceURI });
        }
        cancel() {
          this.canceled = this.current;
          this.current = null;
          this.cancels++;
        }
        end() {
          const u = this.current;
          this.current = null;
          u?.onend?.();
        }
        endCanceled() {
          this.canceled?.onend?.();
        }
        fail() {
          this.current?.onerror?.({ error: 'interrupted' });
        }
      }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance });
      Object.defineProperty(window, 'speechSynthesis', { value: new Synth() });
    });
    const audio = page;
    await audio.goto(`${origin}/stories/${demoBundle.slug}`);
    await expect(audio.getByRole('button', { name: '聴く', exact: true })).toBeVisible();
    assert.equal(
      await audio.evaluate(() => speechSynthesis.calls.length),
      0,
      'reading never auto-plays',
    );
    await audio.getByRole('button', { name: '聴く', exact: true }).focus();
    await audio.keyboard.press('Enter');
    await expect(audio.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
    await expect(audio.locator('.listen button:visible')).toHaveCount(1);
    await expect(audio.locator('.listen summary:visible')).toHaveCount(1);
    await audio.locator('.listen summary').click();
    await audio.getByLabel('聴く場所', { exact: true }).selectOption({ label: '本文 2' });
    await expect(audio.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    const listeningState = await (await request(origin, `/api/stories/${demoBundle.slug}`)).json();
    const listenUrl = `/api/stories/${demoBundle.slug}/listening?revision=${listeningState.revision}`;
    await expect
      .poll(async () => (await (await request(origin, listenUrl)).json()).chunk)
      .toBeGreaterThan(0);
    await audio.getByLabel('読み上げ速度').selectOption('1.25');
    await audio.getByRole('button', { name: '再生', exact: true }).click();
    const last = await audio.evaluate(() => speechSynthesis.calls.at(-1));
    assert.equal(last.rate, 1.25);
    assert.equal(last.voice, 'fixture-ja');
    assert.ok(listeningState.rendering.paragraphs[1].text.startsWith(last.text));
    const calls = await audio.evaluate(() => speechSynthesis.calls.length);
    await audio.evaluate(() => speechSynthesis.endCanceled());
    assert.equal(
      await audio.evaluate(() => speechSynthesis.calls.length),
      calls,
      'late canceled event cannot advance playback',
    );
    await audio.screenshot({ path: 'artifacts/mobile-listening.png', fullPage: true });
    await audio.getByRole('button', { name: '一時停止', exact: true }).click();
    await audio.reload();
    await audio.getByRole('button', { name: '聴く', exact: true }).click();
    assert.equal(
      (await audio.evaluate(() => speechSynthesis.calls.at(-1))).text,
      last.text,
      'reload resumes the saved revision chunk',
    );
    await audio.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(audio.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    await audio.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(audio.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    await audio.getByRole('button', { name: '再生', exact: true }).click();
    await audio.evaluate(() => speechSynthesis.fail());
    await expect(audio.getByRole('alert')).toContainText('音声が止まりました');
    await audio.getByRole('button', { name: '再生', exact: true }).click();
    await audio.evaluate(() => {
      for (let i = 0; i < 100; i++) speechSynthesis.end();
    });
    await expect(audio.getByText('読み上げが終わりました。')).toBeVisible();
    await audio.getByRole('button', { name: 'もう一度聴く' }).click();
    await audio.getByRole('button', { name: '一時停止' }).focus();
    await audio.keyboard.press('Escape');
    await expect(audio.getByRole('button', { name: '聴く', exact: true })).toBeFocused();
    assert.equal(await audio.evaluate(() => speechSynthesis.current), null);
    await audio.evaluate(() => {
      speechSynthesis.voices = [
        {
          voiceURI: 'remote-ja',
          name: '外部音声',
          lang: 'ja-JP',
          localService: false,
          default: true,
        },
      ];
      speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    });
    await expect(
      audio.getByText('この端末で利用できる日本語の読み上げ音声がありません。'),
    ).toBeVisible();
    await expect(audio.getByRole('button', { name: '聴く', exact: true })).toHaveCount(0);
    await expect(audio.locator('.prose')).toBeVisible();
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(
      writes.every(
        (u) =>
          u.includes('/progress') ||
          u.includes('/listening') ||
          u.includes('/views/adopt') ||
          u.includes('/notes') ||
          (u.includes('/api/views/') && !u.includes('/admin/')),
      ),
      'Reading must not start generation.',
    );
    console.log(
      'Browser QA passed: 390/1280px, reading/citations, note/edit history, relation/version evidence, explicit proposal adoption, owner media settings, speech controls/resume/cancellation, no overflow or AI generation from reading.',
    );
  } finally {
    await context.close();
    await browser.close();
  }
});
