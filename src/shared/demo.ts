import type { Bundle, Story } from './model';
// Original synthetic examples. No publisher article is reproduced in the repository.
export const demoBundle: Bundle = {
  slug: 'factory-learning',
  source: {
    url: 'https://example.com/frontier/factory-learning',
    title: 'A factory that learns from each run',
    publisher: 'FRONTIER デモ',
    author: 'FRONTIER',
    language: 'en',
    publishedAt: '2026-10-01T00:00:00Z',
    capturedAt: '2026-10-01T00:00:00Z',
  },
  capture: {
    scope: '動作確認用の自作記事。実在の企業・媒体のニュースではありません。',
    mode: 'full_translation',
    permissions: {
      store: true,
      ai: true,
      translate: true,
      basis: 'Project-authored synthetic fixture',
      checkedAt: '2026-10-01T00:00:00Z',
    },
    paragraphs: [
      {
        id: 'p1',
        text: 'In this fictional pilot, a small factory connects inspection results to its production settings. Each run becomes a record that the next shift can use.',
      },
      {
        id: 'p2',
        text: 'The team says defect rates fell from 8% to 5% over three months. This is a company claim, not an independently verified result. The pilot involved one production line.',
      },
      {
        id: 'p3',
        text: 'The interesting change is not an autonomous factory. It is the ability to preserve the reasons behind adjustments. An operator still reviews every proposed change.',
      },
      {
        id: 'p4',
        text: 'The next question is whether the method works when materials, equipment, and people change. A single successful line does not establish that it will generalize.',
      },
    ],
  },
  rendering: {
    title: '工場は、失敗から学べるか。',
    intro: '検査の記録が、次の生産につながる。自作の架空事例で、変化の仕組みと残る問いを読む。',
    paragraphs: [
      {
        sourceId: 'p1',
        text: 'この架空の実証では、小さな工場が検査結果と生産条件を結びつけています。一回の生産が記録になり、次の担当者も使えるようになりました。',
      },
      {
        sourceId: 'p2',
        text: 'チームによると、不良率は3か月で8%から5%へ低下しました。これは企業側の主張であり、独立して検証された結果ではありません。実証の対象は一つの生産ラインでした。',
      },
      {
        sourceId: 'p3',
        text: '興味深い変化は、工場の自律化ではありません。調整した理由を残せるようになったことです。変更の提案は、引き続き担当者がすべて確認します。',
      },
      {
        sourceId: 'p4',
        text: '次の問いは、材料、設備、担当者が変わっても、この方法が機能するかです。一つのラインでの成功だけでは、ほかにも適用できるとは言えません。',
      },
    ],
    claims: [
      {
        id: 'c1',
        text: '生産条件と検査結果を結ぶことで、調整の理由を次の担当者へ残せる。',
        kind: 'reported_fact',
        evidence: ['p1', 'p3'],
        caveat: '架空の実証事例。変更の判断は人が担う。',
      },
      {
        id: 'c2',
        text: '不良率は3か月で8%から5%へ低下したとチームは述べる。',
        kind: 'company_claim',
        evidence: ['p2'],
        caveat: '対象は一つのライン。独立した検証はない。',
      },
    ],
    concepts: [{ name: '工程学習', meaning: '生産条件と結果の対応を残し、次の調整に使うこと。' }],
    questions: [{ text: '材料や設備が変わっても効果を維持できるか？', evidence: ['p4'] }],
    viewDraft: {
      text: '製造業のAI活用では、自律化の度合いより、判断の根拠を引き継げるかを見たい。',
      evidence: ['p1', 'p3', 'p4'],
    },
    relations: [],
    viewProposal: null,
  },
  processingVersion: 'demo-v1',
};
export function demoStory(): Story {
  const b = demoBundle;
  return {
    currentRevision: 'demo-v1',
    hidden: false,
    slug: b.slug,
    revision: 'demo-v1',
    title: b.rendering.title,
    intro: b.rendering.intro,
    publisher: b.source.publisher,
    publishedAt: b.source.publishedAt,
    mode: b.capture.mode,
    minutes: 3,
    progress: 0,
    source: b.source,
    capture: b.capture,
    rendering: b.rendering,
    capturedAt: b.source.capturedAt,
    drafts: [
      {
        id: 'demo-draft',
        text: b.rendering.viewDraft!.text,
        evidence: b.rendering.viewDraft!.evidence,
        adopted: false,
      },
    ],
    views: [],
    proposals: [],
    connections: [],
    relations: [],
  };
}
