import { ref, type Ref } from 'vue';
import type { GiftReferenceSlot } from './settings';

export type GiftImageReference = {
  id: GiftReferenceSlot;
  kind: 'character' | 'template';
  name: string;
  source: 'local' | 'url';
  mimeType: string;
  fileName: string;
  dataUrl?: string;
  url?: string;
  createdAt: number;
};

const MAX_REFERENCE_DIMENSION = 2048;

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('本地参考图读取失败'));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/is);
  if (!match) throw new Error('参考图数据格式无效');
  const mimeType = match[1] || 'application/octet-stream';
  const body = match[2] || '';
  if (!/;base64/i.test(dataUrl.slice(0, dataUrl.indexOf(',')))) {
    return new Blob([decodeURIComponent(body)], { type: mimeType });
  }
  const binary = atob(body.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function resizeDataUrl(dataUrl: string, mimeType: string): Promise<string> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return dataUrl;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('参考图无法解析'));
    image.src = dataUrl;
  });
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longestSide || longestSide <= MAX_REFERENCE_DIMENSION) return dataUrl;
  const scale = MAX_REFERENCE_DIMENSION / longestSide;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const resized = canvas.toDataURL(mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
  return resized || dataUrl;
}

function referenceKind(slot: GiftReferenceSlot): GiftImageReference['kind'] {
  return slot === 'template' ? 'template' : 'character';
}

function fallbackName(slot: GiftReferenceSlot, fileName: string): string {
  if (fileName.trim()) return fileName.replace(/\.[^.]+$/, '');
  return slot === 'template' ? '模板图' : slot === 'character-1' ? '角色 1' : '角色 2';
}

export function referenceToBlob(reference: GiftImageReference): Blob {
  if (!reference.dataUrl) throw new Error('当前参考图没有可上传的本地数据');
  return dataUrlToBlob(reference.dataUrl);
}

export class ReferenceImageMemory {
  readonly images: Ref<GiftImageReference[]> = ref([]);

  async setLocal(slot: GiftReferenceSlot, file: File, name = ''): Promise<GiftImageReference> {
    if (!file.type.startsWith('image/')) throw new Error('参考图必须是图片文件');
    const rawDataUrl = await fileToDataUrl(file);
    const dataUrl = await resizeDataUrl(rawDataUrl, file.type);
    const reference: GiftImageReference = {
      id: slot,
      kind: referenceKind(slot),
      name: name.trim() || fallbackName(slot, file.name),
      source: 'local',
      mimeType: file.type || 'image/png',
      fileName: file.name || `${slot}.png`,
      dataUrl,
      createdAt: Date.now(),
    };
    this.replace(reference);
    return reference;
  }

  setUrl(slot: GiftReferenceSlot, url: string, name = ''): GiftImageReference {
    const normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) throw new Error('参考图 URL 必须以 http:// 或 https:// 开头');
    const fileName = normalized.split('/').pop()?.split('?')[0] || `${slot}.png`;
    const reference: GiftImageReference = {
      id: slot,
      kind: referenceKind(slot),
      name: name.trim() || fallbackName(slot, fileName),
      source: 'url',
      mimeType: 'image/*',
      fileName,
      url: normalized,
      createdAt: Date.now(),
    };
    this.replace(reference);
    return reference;
  }

  rename(slot: GiftReferenceSlot, name: string): void {
    const reference = this.get(slot);
    if (reference) reference.name = name.trim() || reference.name;
  }

  remove(slot: GiftReferenceSlot): void {
    this.images.value = this.images.value.filter(reference => reference.id !== slot);
  }

  get(slot: GiftReferenceSlot): GiftImageReference | undefined {
    return this.images.value.find(reference => reference.id === slot);
  }

  getRequired(): GiftImageReference[] {
    return (['character-1', 'character-2', 'template'] as GiftReferenceSlot[])
      .map(slot => this.get(slot))
      .filter((reference): reference is GiftImageReference => Boolean(reference));
  }

  clear(): void {
    this.images.value = [];
  }

  private replace(reference: GiftImageReference): void {
    this.images.value = [...this.images.value.filter(item => item.id !== reference.id), reference];
  }
}
