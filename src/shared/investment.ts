import { z } from 'zod';
const statement = z.string().trim().min(1).max(800);
export const thesisSchema = z
  .object({
    hypothesis: statement,
    mechanism: statement,
    beneficiaries: statement,
    headwinds: statement,
    counterEvidence: statement,
    indicators: statement,
    horizon: statement,
    evidence: z
      .array(
        z
          .object({ revision: z.string().length(64), paragraphId: z.string().min(1).max(100) })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const thesisResultSchema = z
  .object({
    theses: z.array(thesisSchema).max(10),
    limitations: statement,
  })
  .strict();
export type ThesisResult = z.infer<typeof thesisResultSchema>;
export type InvestmentArticle = {
  slug: string;
  revision: string;
  captureId: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  mode: string;
  scope: string;
  paragraphs: { id: string; text: string }[];
};
export type InvestmentState = {
  eligible: number;
  selected: number;
  excluded: number;
  used: number;
  aiConfigured: boolean;
  run: null | {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
    stale: boolean;
    result: ThesisResult | null;
    articles: InvestmentArticle[];
  };
};
