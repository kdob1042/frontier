import type { Story } from './model';
import { kindLabels, modeLabels } from './labels';

export interface SpeechChunk {
  text: string;
  section: string;
}
// Short utterances bound the amount replayed after a browser interruption.
// Split Unicode code points, retaining all article numbers and qualifications.
export function speechChunks(text: string, section: string): SpeechChunk[] {
  const clean = text.replace(/https?:\/\/[^\s<>]+/g, '原文リンク').trim();
  const sentences = clean.match(/[^。！？!?\n]+[。！？!?]?|[。！？!?]/gu) || [];
  return sentences.flatMap((sentence) => {
    const characters = Array.from(sentence.trim());
    const chunks: SpeechChunk[] = [];
    for (let i = 0; i < characters.length; i += 180)
      chunks.push({ text: characters.slice(i, i + 180).join(''), section });
    return chunks;
  });
}
export function makeSpeechPlan(story: Story): SpeechChunk[] {
  if (story.mode === 'link_only' || !story.rendering.paragraphs.length) return [];
  return [
    ...speechChunks(
      `${story.title}。${modeLabels[story.mode]}。原著、${story.source.author}。媒体、${story.publisher}。${story.capture.scope}。機械翻訳です。記事の主張は独立した検証を意味しません。${story.intro}`,
      '記事の紹介と取得範囲',
    ),
    ...story.rendering.paragraphs.flatMap((p, i) => speechChunks(p.text, `本文 ${i + 1}`)),
    ...story.rendering.claims.flatMap((c, i) =>
      speechChunks(
        `${i === 0 ? 'ここからはAIが抽出した知見です。' : ''}${kindLabels[c.kind]}。${c.text}${c.caveat ? `。留保、${c.caveat}` : ''}`,
        'AIが抽出した知見',
      ),
    ),
  ];
}
