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
    await personal.getByRole('button', { name: '新しい版として保存' }).click();
    await expect(page.getByText('本人が編集した見方', { exact: true })).toBeVisible();
    const views = await (await request(origin, '/api/views')).json();
    const view = views.views.find((v) => v.text === '本人が編集した見方');
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
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(
      writes.every(
        (u) =>
          u.includes('/progress') ||
          u.includes('/views/adopt') ||
          u.includes('/notes') ||
          (u.includes('/api/views/') && !u.includes('/admin/')),
      ),
      'Reading must not start generation.',
    );
    console.log(
      'Browser QA passed: 390/1280px, reading/citations, note/edit history, relation/version evidence, explicit proposal adoption, owner media settings, no overflow or AI generation from reading.',
    );
  } finally {
    await context.close();
    await browser.close();
  }
});
