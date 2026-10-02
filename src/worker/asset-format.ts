import { StoreError } from './storage';
export function wavSeconds(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (n: number, size: number) => new TextDecoder().decode(bytes.slice(n, n + size));
  if (
    bytes.length < 44 ||
    text(0, 4) !== 'RIFF' ||
    text(8, 4) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    throw new StoreError('invalid_pcm_audio', 400);
  let block = 0,
    rate = 0,
    data = 0,
    format = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true),
      start = offset + 8;
    if (start + size > bytes.length) throw new StoreError('invalid_pcm_audio', 400);
    if (text(offset, 4) === 'fmt ') {
      if (
        size < 16 ||
        format ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw new StoreError('invalid_pcm_audio', 400);
      format = true;
      rate = view.getUint32(start + 4, true);
      block = view.getUint16(start + 12, true);
      if (rate !== 16000 || block !== 2 || view.getUint32(start + 8, true) !== rate * block)
        throw new StoreError('invalid_pcm_audio', 400);
    }
    if (text(offset, 4) === 'data') {
      if (data || size % 2) throw new StoreError('invalid_pcm_audio', 400);
      data = size;
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new StoreError('invalid_pcm_audio', 400);
  return data / rate / block;
}
export function checkImage(bytes: Uint8Array, mime: string) {
  let width = 0,
    height = 0;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mime === 'image/png' &&
    bytes.length >= 24 &&
    bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
  ) {
    width = v.getUint32(16);
    height = v.getUint32(20);
  }
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let n = 2;
    while (n + 4 < bytes.length) {
      if (bytes[n] !== 255) break;
      const marker = bytes[n + 1],
        size = v.getUint16(n + 2);
      if (size < 2 || n + 2 + size > bytes.length) break;
      if ([192, 193, 194].includes(marker) && size >= 8) {
        height = v.getUint16(n + 5);
        width = v.getUint16(n + 7);
        break;
      }
      n += 2 + size;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304)
    throw new StoreError('image_dimensions_not_supported', 400);
  return { width, height };
}
