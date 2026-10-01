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
      writes.every((u) => u.includes('/progress') || u.includes('/views/adopt')),
      'Reading must not start generation.',
    );
    console.log(
      'Browser QA passed: 390/1280px, home→reader→citations→adoption→search, reload/progress, one primary action, no overflow, no generation on reading.',
    );
  } finally {
    await context.close();
    await browser.close();
  }
});
