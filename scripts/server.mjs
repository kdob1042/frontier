import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
export async function command(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [wrangler, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      error = '';
    p.stdout.on('data', (b) => {
      output = (output + b).slice(-16000);
    });
    p.stderr.on('data', (b) => {
      error = (error + b).slice(-12000);
    });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output + error))));
  });
}
export async function withServer(port, run, env = '') {
  const state = await mkdtemp(join(tmpdir(), 'frontier-qa-'));
  let server,
    log = '';
  try {
    await command([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      state,
      '--env',
      env,
    ]);
    server = spawn(
      process.execPath,
      [
        wrangler,
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        String(port + 100),
        '--persist-to',
        state,
        '--env',
        env,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const s of [server.stdout, server.stderr])
      s.on('data', (b) => {
        log = (log + b).slice(-12000);
      });
    const origin = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (server.exitCode !== null) throw new Error(log);
      try {
        const r = await fetch(`${origin}/api/home`);
        if (r.status === 200 || r.status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await delay(250);
    }
    if (!ready) throw new Error(log);
    return await run(origin, state);
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(() => {
          server.kill('SIGKILL');
          resolve();
        }, 5000).unref();
      });
    }
    await rm(state, { recursive: true, force: true });
  }
}
export async function request(origin, path, { body, headers = {}, method = 'GET' } = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(method === 'GET' ? {} : { Origin: origin }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
