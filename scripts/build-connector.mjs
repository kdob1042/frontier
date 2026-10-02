import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
const assets = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else
      assets[path.slice(4)] = {
        body: readFileSync(path, 'utf8'),
        type: path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      };
  }
}
walk('dist');
writeFileSync(
  'dist-worker/connector-entry.ts',
  `import worker from '../src/worker/index';\nexport {HarvestWorkflow,DailyWorkflow,MediaWorkflow} from '../src/worker/index';\nconst assets=${JSON.stringify(assets)};\nexport default {...worker,fetch(request,env,ctx){return worker.fetch(request,{...env,ASSETS:{async fetch(r){const path=new URL(r.url).pathname;const a=assets[path] || (!path.startsWith('/assets/')?assets['/index.html']:null);return a?new Response(r.method==='HEAD'?null:a.body,{headers:{'Content-Type':a.type+'; charset=utf-8'}}):new Response('Not found',{status:404});}}},ctx);}};`,
);
await build({
  entryPoints: ['dist-worker/connector-entry.ts'],
  outfile: 'dist-worker/connector.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  external: ['cloudflare:*', 'node:*'],
});
