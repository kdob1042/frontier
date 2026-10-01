import assert from 'node:assert/strict';
import { demoBundle } from '../src/shared/demo.ts';
import { withServer, request, command } from './server.mjs';
await withServer(8793, async (origin, state) => {
  const home = await (await request(origin, '/api/home')).json();
  assert.equal(home.recommended, null);
  const input = structuredClone(demoBundle);
  const imported = await (
    await request(origin, '/api/admin/import', { method: 'POST', body: input })
  ).json();
  assert.ok(imported.revision);
  const duplicate = await (
    await request(origin, '/api/admin/import', { method: 'POST', body: input })
  ).json();
  assert.equal(duplicate.duplicate, true);
  const story = await (await request(origin, `/api/stories/${input.slug}`)).json();
  assert.equal(story.rendering.claims.length, 2);
  assert.equal(story.views.length, 0);
  assert.equal(story.drafts[0].adopted, false);
  assert.equal((await request(origin, '/api/stories?q=生産条件')).status, 200);
  assert.equal((await (await request(origin, '/api/stories?q=8%')).json()).stories.length, 1);
  assert.equal((await (await request(origin, '/api/stories?q=不存在')).json()).stories.length, 0);
  const link = structuredClone(input);
  link.slug = 'link-only';
  link.source.url = 'https://example.com/link-only';
  link.capture.mode = 'link_only';
  link.capture.paragraphs = [];
  link.capture.permissions = {
    ...link.capture.permissions,
    store: false,
    ai: false,
    translate: false,
  };
  link.rendering = {
    title: '未取得の記事',
    intro: '原文リンクのみを残す例',
    paragraphs: [],
    claims: [],
    concepts: [],
    questions: [],
    viewDraft: null,
  };
  assert.equal(
    (await request(origin, '/api/admin/import', { method: 'POST', body: link })).status,
    200,
  );
  await request(origin, `/api/stories/${input.slug}/progress`, {
    method: 'PUT',
    body: { fraction: 0.45, updatedAt: Date.now() },
  });
  await request(origin, `/api/stories/${input.slug}/progress`, {
    method: 'PUT',
    body: { fraction: 0.1, updatedAt: 1 },
  });
  assert.equal((await (await request(origin, `/api/stories/${input.slug}`)).json()).progress, 0.45);
  const adopt = { draftId: story.drafts[0].id, revision: story.revision };
  assert.equal(
    (await request(origin, '/api/views/adopt', { method: 'POST', body: adopt })).status,
    200,
  );
  assert.equal(
    (await (await request(origin, '/api/views/adopt', { method: 'POST', body: adopt })).json())
      .duplicate,
    true,
  );
  input.rendering.title = '更新した記事';
  input.processingVersion = 'demo-v2';
  assert.equal(
    (await request(origin, '/api/admin/import', { method: 'POST', body: input })).status,
    409,
  );
  const updated = await (
    await request(origin, '/api/admin/import', {
      method: 'POST',
      headers: { 'If-Match': story.revision },
      body: input,
    })
  ).json();
  assert.ok(updated.revision);
  const newer = await (await request(origin, `/api/stories/${input.slug}`)).json();
  assert.equal(newer.views.length, 1);
  assert.equal(newer.drafts[0].adopted, false);
  const invalid = structuredClone(input);
  invalid.rendering.claims[0].evidence = ['unseen'];
  assert.equal(
    (await request(origin, '/api/admin/import', { method: 'POST', body: invalid })).status,
    400,
  );
  const exportData = await (await request(origin, '/api/export')).json();
  assert.equal(exportData.version, 1);
  assert.equal(exportData.view_revisions.length, 1);
  assert.equal(exportData.renderings.length, 3);
  const crossOrigin = await fetch(`${origin}/api/views/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify(adopt),
  });
  assert.equal(crossOrigin.status, 403);
  const capture = { slug: input.slug, source: input.source, capture: input.capture };
  const saved = await (
    await request(origin, '/api/admin/captures', { method: 'POST', body: capture })
  ).json();
  assert.ok(saved.captureId);
  assert.equal(
    (
      await request(origin, '/api/admin/jobs', {
        method: 'POST',
        body: { captureId: saved.captureId, expectedRevision: newer.revision },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(origin, `/api/admin/stories/${input.slug}`, {
        method: 'DELETE',
        headers: { 'If-Match': newer.revision },
      })
    ).status,
    200,
  );
  assert.equal((await request(origin, `/api/stories/${input.slug}`)).status, 404);
  assert.equal(
    (await request(origin, '/api/admin/import', { method: 'POST', body: input })).status,
    409,
  );
  const afterDelete = await (await request(origin, '/api/export')).json();
  assert.equal(afterDelete.view_revisions[0].evidence_missing, 1);
  assert.equal(afterDelete.captures.length, 1);
  assert.equal(afterDelete.renderings.length, 1);
  assert.equal(afterDelete.claims.length, 0);
  // Captured material can also be removed before translation has finished.
  const pending = structuredClone(demoBundle);
  pending.slug = 'pending-fixture';
  pending.source.url = 'https://example.com/pending-fixture';
  const raw = { slug: pending.slug, source: pending.source, capture: pending.capture };
  assert.equal(
    (await request(origin, '/api/admin/captures', { method: 'POST', body: raw })).status,
    200,
  );
  assert.equal(
    (
      await request(origin, '/api/admin/stories/pending-fixture', {
        method: 'DELETE',
        headers: { 'If-Match': 'pending' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(origin, '/api/admin/captures', { method: 'POST', body: raw })).status,
    409,
  );
  // Two competing updates must leave exactly one new rendering, with no orphan private output.
  const race = structuredClone(demoBundle);
  race.slug = 'race-fixture';
  race.source.url = 'https://example.com/race-fixture';
  const first = await (
    await request(origin, '/api/admin/import', { method: 'POST', body: race })
  ).json();
  const beforeRace = await (await request(origin, '/api/export')).json();
  const competing = await Promise.all(
    ['A', 'B'].map(async (label) => {
      const changed = structuredClone(race);
      changed.rendering.title = `競合した更新 ${label}`;
      return request(origin, '/api/admin/import', {
        method: 'POST',
        headers: { 'If-Match': first.revision },
        body: changed,
      });
    }),
  );
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const afterRace = await (await request(origin, '/api/export')).json();
  assert.equal(afterRace.renderings.length, beforeRace.renderings.length + 1);
  // Query the actual on-disk D1 state independently of the HTTP path.
  const db = await command([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    state,
    '--command',
    'SELECT COUNT(*) AS n FROM view_revisions',
    '--json',
  ]);
  assert.equal(JSON.parse(db)[0].results[0].n, 1);
  console.log(
    'D1 integration: import, dedup, citations, Japanese search, progress, explicit adoption, revisions, export, deletion, CSRF, AI-off passed.',
  );
});
await withServer(
  8794,
  async (origin) => {
    for (const path of [
      '/',
      '/archive',
      '/demo',
      '/api/home',
      '/api/stories',
      '/api/views',
      '/api/export',
      '/api/admin/status',
    ])
      assert.equal((await request(origin, path)).status, 401);
    console.log('Preview: unauthenticated HTML, demo, APIs and export all rejected.');
  },
  'preview',
);
