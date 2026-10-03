import { z } from 'zod';
import { safeUrl } from './model';
export const MAX_VIDEO_SECONDS = 180;
export const MAX_MEDIA_BYTES = 12_000_000;
export const preparedAssetSchema = z
  .object({
    kind: z.enum(['image', 'audio', 'frame', 'pdf']),
    mime: z.enum(['image/png', 'image/jpeg', 'audio/wav', 'application/pdf']),
    data: z.string().min(1).max(8_000_000),
    seconds: z.number().min(0).max(MAX_VIDEO_SECONDS).optional(),
  })
  .strict();
export const mediaUploadSchema = z
  .object({
    registryId: z.string().min(1).max(100),
    url: safeUrl,
    kind: z.enum(['image', 'audio', 'video', 'pdf']),
    assets: z.array(preparedAssetSchema).min(1).max(5),
    expectedRevision: z.string().length(64).nullable().default(null),
  })
  .strict();
export type PreparedAsset = z.infer<typeof preparedAssetSchema>;
export type MediaUpload = z.infer<typeof mediaUploadSchema>;
export const originLabels = {
  publisher_text: '配信本文',
  publisher_caption: '配信字幕',
  ocr: 'OCR（AI読み取り）',
  transcript: '音声の自動文字起こし',
  visual_description: '図・映像のAIによる説明',
};
export function originLink(origin: { url: string; kind: string; startSeconds?: number }) {
  const u = new URL(origin.url);
  if (origin.kind === 'video' && origin.startSeconds !== undefined) {
    if (['youtube.com', 'www.youtube.com', 'youtu.be'].includes(u.hostname))
      u.searchParams.set('t', String(Math.floor(origin.startSeconds)));
    else u.hash = `t=${origin.startSeconds}`;
  }
  if (origin.kind === 'pdf' && 'page' in origin) u.hash = `page=${origin.page}`;
  return u.href;
}
export const timeLabel = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
