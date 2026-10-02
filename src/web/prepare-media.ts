import { MAX_MEDIA_BYTES, MAX_VIDEO_SECONDS, type PreparedAsset } from '../shared/media';
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let n = 0; n < bytes.length; n += 8192)
    text += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(text);
};
async function jpeg(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const scale = Math.min(1, 1024 / Math.max(width, height)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}
export function pcmWav(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    v = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return new Uint8Array(buffer);
}
export async function prepareMedia(
  blob: Blob,
  kind: 'image' | 'audio' | 'video' | 'pdf',
): Promise<PreparedAsset[]> {
  if (blob.size > MAX_MEDIA_BYTES)
    throw new Error('ファイルは12MBまでです。長い動画は配信字幕を取り込んでください。');
  if (kind === 'pdf') {
    if (blob.size > 2000000) throw new Error('PDFは2MBまでです。');
    return [
      {
        kind: 'pdf',
        mime: 'application/pdf',
        data: base64(new Uint8Array(await blob.arrayBuffer())),
      },
    ];
  }
  if (kind === 'image') {
    const image = await createImageBitmap(blob);
    try {
      return [
        { kind: 'image', mime: 'image/jpeg', data: await jpeg(image, image.width, image.height) },
      ];
    } finally {
      image.close();
    }
  }
  // Decode locally, never play audio; PCM makes duration and the reserved transcription cost verifiable.
  const decoder = new OfflineAudioContext(1, 1, 16000);
  let audio: AudioBuffer;
  try {
    audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error(
      'このブラウザで音声を読み取れません。字幕ファイルを使うか、対応する音声/動画ファイルを指定してください。',
    );
  }
  if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_VIDEO_SECONDS)
    throw new Error(
      '音声・動画の直接取り込みは3分までです。長い動画は配信字幕を取り込んでください。',
    );
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const channel = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.numberOfChannels;
  }
  const assets: PreparedAsset[] = [
    { kind: 'audio', mime: 'audio/wav', data: base64(pcmWav(mono)) },
  ];
  if (kind === 'audio') return assets;
  const objectUrl = URL.createObjectURL(blob),
    video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = objectUrl;
  const event = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('動画フレームの読み取りが時間切れになりました。')),
        15000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.removeEventListener(name, ok);
        video.removeEventListener('error', bad);
        error ? reject(error) : resolve();
      };
      const ok = () => finish(),
        bad = () => finish(new Error('動画フレームを読み取れません。'));
      video.addEventListener(name, ok, { once: true });
      video.addEventListener('error', bad, { once: true });
    });
  try {
    const loaded = event('loadeddata');
    video.load();
    await loaded;
    for (let i = 0; i < 4; i++) {
      const seconds = ((i + 0.5) * audio.duration) / 4,
        seek = event('seeked');
      video.currentTime = seconds;
      await seek;
      assets.push({
        kind: 'frame',
        mime: 'image/jpeg',
        seconds,
        data: await jpeg(video, video.videoWidth, video.videoHeight),
      });
    }
    return assets;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
