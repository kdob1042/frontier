import { parse } from 'jsonc-parser';

export function deploymentConfig(text, target) {
  if (!['preview', 'production'].includes(target))
    throw new Error('Specify preview or production: npm run deploy -- preview');
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object')
    throw new Error('Invalid wrangler.jsonc configuration.');
  const env = config.env?.[target];
  if (
    env?.vars?.ENVIRONMENT !== target ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.vars.ACCESS_TEAM_DOMAIN) ||
    !env.vars.ACCESS_AUD ||
    !env.vars.OWNER_EMAIL
  )
    throw new Error('Configure Access issuer, audience and owner before deployment.');
  if (!env.d1_databases?.[0]?.database_id)
    throw new Error('Create a separate D1 database and set its database_id first.');
  const workerAccess = /^[a-f0-9]{32}$/.test(env.access_worker_id || '') && !!env.access_app_id;
  if (!env.routes?.length && !workerAccess)
    throw new Error('Configure an Access-protected custom domain route. workers.dev is disabled.');
  if (env.workers_dev !== false && !workerAccess)
    throw new Error('Disable workers.dev for private deployment.');
  return env;
}
