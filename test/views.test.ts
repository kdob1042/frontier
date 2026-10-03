import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteRuntime } from './sqlite-runtime';
import { demoBundle } from '../src/shared/demo';
import { importBundle, getStory, adoptDraft, deleteSource } from '../src/worker/storage';
import { addNote, editView, listViews, viewHistory } from '../src/worker/views';
import { exportMarkdown } from '../src/worker/markdown';

test('explicit adoption, notes and CAS edits keep immutable history; source updates and deletion never overwrite the owner', async () => {
  const { db, sqlite } = sqliteRuntime();
  try {
    const saved = await importBundle(db, demoBundle),
      story = await getStory(db, demoBundle.slug);
    assert.ok(story);
    await adoptDraft(db, story.drafts[0].id, saved.revision);
    const root = story.drafts[0].id;
    const edit = await editView(db, root, { expectedRevision: root, text: '本人が考え直した文章' });
    await assert.rejects(
      () => editView(db, root, { expectedRevision: root, text: '遅れて届いた訂正' }),
      /conflict/,
    );
    await adoptDraft(db, story.drafts[0].id, saved.revision);
    assert.equal(
      (await listViews(db))[0].text,
      '本人が考え直した文章',
      're-adoption must not reset the edited head',
    );
    const note = await addNote(db, demoBundle.slug, {
      revision: saved.revision,
      text: '<script>alert(1)</script> 自分のメモ',
    });
    assert.equal((await getStory(db, demoBundle.slug))!.views.length, 2);
    assert.equal((await viewHistory(db, root)).length, 2);
    const changed = structuredClone(demoBundle);
    changed.processingVersion = 'updated';
    changed.rendering.title = '原文更新の派生版';
    const update = await importBundle(db, changed, saved.revision);
    const historical = await getStory(db, demoBundle.slug, saved.revision);
    assert.ok(historical);
    assert.equal(historical.title, demoBundle.rendering.title);
    assert.equal(historical.currentRevision, update.revision);
    assert.equal(
      (await listViews(db)).find((v) => v.root_id === root)!.text,
      '本人が考え直した文章',
    );
    await deleteSource(db, demoBundle.slug, update.revision);
    await editView(db, root, {
      expectedRevision: edit.id,
      text: '原資料削除後にも保持する本人の文章',
    });
    const history = await viewHistory(db, root);
    assert.equal(history.length, 3);
    assert.ok(history.every((v) => v.evidence_missing === 1));
    assert.equal((await listViews(db)).find((v) => v.root_id === note.rootId)!.evidence_missing, 1);
    const markdown = await exportMarkdown(db);
    assert.ok(markdown.includes('本人が考え直した文章'));
    assert.ok(markdown.includes('原資料削除後にも保持する本人の文章'));
    assert.ok(markdown.includes('&lt;script&gt;'));
    assert.ok(!markdown.includes('<script>'));
    assert.ok(
      !markdown.includes(demoBundle.capture.paragraphs[0].text),
      'deleted original must not enter export',
    );
  } finally {
    sqlite.close();
  }
});

test('AI view revisions remain proposals until explicit adoption; hidden records stay hidden across updates', async () => {
  const { db, sqlite } = sqliteRuntime();
  try {
    const { setVisibility, listStories } = await import('../src/worker/storage');
    const { adoptProposal } = await import('../src/worker/views');
    const base = await importBundle(db, demoBundle),
      story = await getStory(db, demoBundle.slug);
    assert.ok(story);
    const root = story.drafts[0].id;
    await adoptDraft(db, root, base.revision);
    const second = structuredClone(demoBundle);
    second.slug = 'view-proposal-fixture';
    second.source.url = 'https://example.com/view-proposal-fixture';
    second.rendering.viewDraft = null;
    second.rendering.viewProposal = {
      rootId: root,
      expectedRevision: root,
      text: '新しい根拠を受けて条件を限定する案',
      evidence: ['p1'],
    };
    const saved = await importBundle(db, second);
    assert.equal(
      (await listViews(db))[0].text,
      demoBundle.rendering.viewDraft!.text,
      'automatic proposal cannot change the owner',
    );
    const proposed = (await getStory(db, second.slug))!.proposals[0];
    assert.equal(proposed.stale, false);
    await adoptProposal(db, proposed.id, saved.revision);
    assert.equal((await listViews(db))[0].text, second.rendering.viewProposal.text);
    assert.equal((await adoptProposal(db, proposed.id, saved.revision)).duplicate, true);
    const later = structuredClone(second);
    later.processingVersion = 'proposal-v2';
    later.rendering.viewProposal!.expectedRevision = (await listViews(db))[0].id;
    later.rendering.viewProposal!.text = '明示採用前に本人が編集したら無効になる案';
    const next = await importBundle(db, later, saved.revision),
      proposal = (await getStory(db, second.slug))!.proposals[0];
    await editView(db, root, {
      expectedRevision: later.rendering.viewProposal!.expectedRevision,
      text: '本人が先に編集した文章',
    });
    await assert.rejects(() => adoptProposal(db, proposal.id, next.revision), /conflict/);
    await setVisibility(db, second.slug, next.revision, true);
    assert.equal(
      (await listStories(db)).some((s) => s.slug === second.slug),
      false,
    );
    assert.equal(
      (await getStory(db, second.slug))!.hidden,
      true,
      'owner can still open evidence directly',
    );
    later.processingVersion = 'hidden-update';
    later.rendering.viewProposal = null;
    const hiddenUpdate = await importBundle(db, later, next.revision);
    assert.equal(
      (await listStories(db)).some((s) => s.slug === second.slug),
      false,
      'import cannot undo the owner visibility choice',
    );
    await setVisibility(db, second.slug, hiddenUpdate.revision, false);
    assert.equal(
      (await listStories(db)).some((s) => s.slug === second.slug),
      true,
    );
  } finally {
    sqlite.close();
  }
});
