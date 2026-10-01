import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const target = process.argv[2];
if (!['preview', 'production'].includes(target))
  throw new Error('Specify preview or production: npm run deploy -- preview');
// The checked-in config is strict JSON despite its .jsonc extension.
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const env = config.env[target];
if (
  env.vars.ENVIRONMENT !== target ||
  !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.vars.ACCESS_TEAM_DOMAIN) ||
  !env.vars.ACCESS_AUD ||
  !env.vars.OWNER_EMAIL
)
  throw new Error('Configure Access issuer, audience and owner before deployment.');
if (!env.d1_databases[0].database_id)
  throw new Error('Create a separate D1 database and set its database_id first.');
if (!env.routes?.length)
  throw new Error('Configure an Access-protected custom domain route. workers.dev is disabled.');
for (const cmd of [
  ['run', 'build'],
  ['exec', 'wrangler', '--', 'deploy', '--env', target],
]) {
  const r = spawnSync('npm', cmd, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
