import { z } from 'zod';

export const modes = ['full_translation', 'partial_translation', 'summary', 'link_only'] as const;
const short = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(12000);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const safeUrl = z
  .string()
  .url()
  .max(2000)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  }, 'HTTPS URL required');
const paragraph = z.object({ id: idSchema, text }).strict();
const evidence = z.array(idSchema).min(1).max(12);
export const relationSchema = z
  .object({
    toRevision: z.string().length(64),
    fromClaim: idSchema,
    toClaim: idSchema,
    kind: z.enum(['supports', 'challenges', 'qualifies', 'analogous_to']),
    reason: short,
    conditions: z.string().min(1).max(1000),
    fromEvidence: evidence,
    toEvidence: evidence,
  })
  .strict();
export const claimSchema = z
  .object({
    id: idSchema,
    text: short,
    kind: z.enum(['reported_fact', 'company_claim', 'author_interpretation', 'ai_inference']),
    evidence,
    caveat: z.string().max(1000),
  })
  .strict();
export const generatedSchema = z
  .object({
    title: short,
    intro: z.string().min(1).max(1000),
    paragraphs: z.array(z.object({ sourceId: idSchema, text }).strict()).max(80),
    claims: z.array(claimSchema).max(3),
    concepts: z.array(z.object({ name: short, meaning: short }).strict()).max(8),
    questions: z.array(z.object({ text: short, evidence }).strict()).max(3),
    viewDraft: z.object({ text: short, evidence }).strict().nullable(),
    viewProposal: z
      .object({ rootId: idSchema, expectedRevision: idSchema, text: short, evidence })
      .strict()
      .nullable()
      .default(null),
    relations: z.array(relationSchema).max(3).default([]),
  })
  .strict();
export const bundleSchema = z
  .object({
    slug: idSchema,
    source: z
      .object({
        url: safeUrl,
        title: short,
        publisher: short,
        author: short,
        language: short,
        publishedAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }).optional(),
        capturedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    capture: z
      .object({
        scope: short,
        mode: z.enum(modes),
        paragraphs: z.array(paragraph).max(80),
        permissions: z
          .object({
            store: z.boolean(),
            ai: z.boolean(),
            translate: z.boolean(),
            basis: z.string().min(1).max(12000),
            checkedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      })
      .strict(),
    rendering: generatedSchema,
    processingVersion: idSchema,
  })
  .strict();
export type Bundle = z.infer<typeof bundleSchema>;
export type Generated = z.infer<typeof generatedSchema>;
export function validateBundle(input: unknown): Bundle {
  const b = bundleSchema.parse(input);
  const ids = new Set(b.capture.paragraphs.map((p) => p.id));
  if (ids.size !== b.capture.paragraphs.length) throw new Error('duplicate_paragraph');
  if (!b.capture.permissions.store && ids.size) throw new Error('storage_not_permitted');
  if (
    b.capture.mode === 'link_only' &&
    (ids.size ||
      b.rendering.paragraphs.length ||
      b.rendering.claims.length ||
      b.rendering.concepts.length ||
      b.rendering.questions.length ||
      b.rendering.viewDraft ||
      b.rendering.viewProposal ||
      b.rendering.relations.length)
  )
    throw new Error('link_only_has_content');
  if (b.capture.mode !== 'link_only' && !ids.size) throw new Error('missing_source');
  if (b.capture.mode !== 'link_only' && !b.capture.permissions.translate)
    throw new Error('translation_not_permitted');
  const refs = [
    ...b.rendering.paragraphs.map((p) => p.sourceId),
    ...b.rendering.claims.flatMap((c) => c.evidence),
    ...b.rendering.questions.flatMap((q) => q.evidence),
    ...(b.rendering.viewDraft?.evidence || []),
    ...(b.rendering.viewProposal?.evidence || []),
  ];
  if (refs.some((r) => !ids.has(r))) throw new Error('invalid_evidence');
  for (const r of b.rendering.relations) {
    const claim = b.rendering.claims.find((c) => c.id === r.fromClaim);
    if (!claim || r.fromEvidence.some((e) => !claim.evidence.includes(e)))
      throw new Error('invalid_relation_evidence');
  }
  if (new Set(b.rendering.claims.map((c) => c.id)).size !== b.rendering.claims.length)
    throw new Error('duplicate_claim');
  if (b.capture.mode === 'full_translation' || b.capture.mode === 'partial_translation') {
    if (
      b.rendering.paragraphs.length !== ids.size ||
      b.rendering.paragraphs.some((p, i) => p.sourceId !== b.capture.paragraphs[i]?.id)
    )
      throw new Error('missing_or_reordered_translation');
  }
  return b;
}
export interface StorySummary {
  slug: string;
  revision: string;
  title: string;
  intro: string;
  publisher: string;
  publishedAt: string;
  mode: Bundle['capture']['mode'];
  minutes: number;
  progress: number;
}
export interface Story extends StorySummary {
  currentRevision: string;
  hidden: boolean;
  source: Bundle['source'];
  capture: Bundle['capture'];
  rendering: Generated;
  capturedAt: string;
  drafts: Array<{ id: string; text: string; adopted: boolean; evidence: string[] }>;
  proposals: Array<{
    id: string;
    text: string;
    previousText: string;
    evidence: string[];
    rootId: string;
    expectedRevision: string;
    adopted: boolean;
    stale: boolean;
  }>;
  views: Array<{
    id: string;
    rootId: string;
    kind: 'adoption' | 'edit' | 'note';
    text: string;
    createdAt: string;
    evidenceMissing: boolean;
  }>;
  connections: Array<{ slug: string; title: string; concept: string }>;
  relations: Array<
    z.infer<typeof relationSchema> & {
      id: string;
      slug: string;
      title: string;
      independent: boolean;
    }
  >;
}

export { modeLabels, relationLabels, kindLabels } from './labels';
