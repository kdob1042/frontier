import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { wavSeconds, checkImage } from '../src/worker/asset-format.ts';
const dir = await mkdtemp(join(tmpdir(), 'frontier-browser-media-'));
let server, browser;
try {
  await build({
    entryPoints: ['src/web/prepare-media.ts'],
    outfile: join(dir, 'prepare.mjs'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
  });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000',
      '-t',
      '2',
      '-c:v',
      'libvpx-vp9',
      '-c:a',
      'libopus',
      join(dir, 'fixture.webm'),
    ],
    { timeout: 30000 },
  );
  server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><title>Self-authored media check</title><body>Media check</body></html>',
      );
      return;
    }
    const name =
      req.url === '/prepare.mjs'
        ? 'prepare.mjs'
        : req.url === '/fixture.webm'
          ? 'fixture.webm'
          : null;
    if (!name) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('mjs') ? 'text/javascript' : 'video/webm');
    res.end(await readFile(join(dir, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? {
          executablePath: process.env.BROWSER_EXECUTABLE,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    let played = 0;
    HTMLMediaElement.prototype.play = async () => {
      played++;
    };
    const { prepareMedia } = await import('/prepare.mjs');
    const blob = await (await fetch('/fixture.webm')).blob();
    const assets = await prepareMedia(blob, 'video');
    return { assets, played };
  });
  assert.equal(result.played, 0);
  assert.equal(result.assets.length, 5);
  const audio = result.assets.find((a) => a.kind === 'audio');
  const seconds = wavSeconds(new Uint8Array(Buffer.from(audio.data, 'base64')));
  assert.ok(seconds >= 1.9 && seconds <= 2.2);
  const frames = result.assets.filter((a) => a.kind === 'frame');
  assert.equal(frames.length, 4);
  for (const frame of frames) {
    assert.ok(frame.seconds > 0 && frame.seconds < seconds);
    assert.deepEqual(checkImage(new Uint8Array(Buffer.from(frame.data, 'base64')), frame.mime), {
      width: 320,
      height: 180,
    });
  }
  assert.ok(frames.every((frame, i) => i === 0 || frame.seconds > frames[i - 1].seconds));
  console.log(
    'Browser media QA passed: real self-authored WebM → mono 16kHz PCM + 4 JPEG frames with source times; no playback or provider call.',
  );
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
