import { demoBundle } from '../src/shared/demo.ts';
const origin = process.argv[2] || 'http://localhost:8792';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
  throw new Error('Demo seeding is restricted to local development.');
const response = await fetch(`${origin}/api/admin/import`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(demoBundle),
});
if (!response.ok) throw new Error(`Demo import failed (${response.status})`);
console.log('自作のデモ記事を保存しました。');
