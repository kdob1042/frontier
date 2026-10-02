import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentConfig } from '../scripts/deploy-config.mjs';
const valid = {
  workers_dev: false,
  vars: {
    ENVIRONMENT: 'production',
    ACCESS_TEAM_DOMAIN: 'fixture.cloudflareaccess.com',
    ACCESS_AUD: 'fixture-aud',
    OWNER_EMAIL: 'owner@example.com',
  },
  d1_databases: [{ database_id: 'fixture-db' }],
  routes: [{ pattern: 'fixture.example.com', custom_domain: true }],
};
test('deployment accepts JSONC comments and trailing commas, rejects malformed input before any command', () => {
  const text = JSON.stringify({ env: { production: valid } })
    .replace('"env":', '// config comment\n"env":')
    .replace(/}$/, ',}');
  assert.equal(deploymentConfig(text, 'production').vars.ENVIRONMENT, 'production');
  assert.throws(() => deploymentConfig('{"env":', 'production'), /Invalid wrangler/);
  assert.throws(() => deploymentConfig(text, 'local'), /Specify preview or production/);
});
test('checked-in configuration reaches missing-Access guard; private deployment still requires Access, D1, route and workers.dev off', () => {
  const actual = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.throws(() => deploymentConfig(actual, 'production'), /Configure Access/);
  for (const [mutate, expected] of [
    [(e) => delete e.vars.ACCESS_AUD, /Configure Access/],
    [(e) => delete e.d1_databases[0].database_id, /separate D1/],
    [(e) => delete e.routes, /custom domain/],
    [(e) => (e.workers_dev = true), /Disable workers.dev/],
  ]) {
    const env = structuredClone(valid);
    mutate(env);
    assert.throws(
      () => deploymentConfig(JSON.stringify({ env: { production: env } }), 'production'),
      expected,
    );
  }
});
