import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { deploymentConfig } from './deploy-config.mjs';
const target = process.argv[2];
deploymentConfig(await readFile('wrangler.jsonc', 'utf8'), target);
for (const cmd of [
  ['run', 'build'],
  ['exec', 'wrangler', '--', 'deploy', '--env', target],
]) {
  const r = spawnSync('npm', cmd, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
