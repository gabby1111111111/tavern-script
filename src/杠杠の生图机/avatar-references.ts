/**
 * 读取当前聊天上下文中可用的两张角色参考图。
 *
 * 参考图是一次生成任务的临时输入：这里只返回当前运行时可用的路径或
 * data URL，不把它写入脚本变量、聊天消息或浏览器存储。
 */

export type AvatarReferenceSource = 'persona' | 'character';

export type CurrentAvatarReference = {
  source: AvatarReferenceSource;
  value: string;
};

export type AvatarReferenceReadResult = {
  references: CurrentAvatarReference[];
  failedSources: AvatarReferenceSource[];
};

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('当前运行时不支持读取角色头像'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = normalizePath(reader.result);
      if (result) resolve(result);
      else reject(new Error('角色头像读取结果为空'));
    };
    reader.onerror = () => reject(new Error('角色头像读取失败'));
    reader.readAsDataURL(blob);
  });
}

function characterAvatarPath(value: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(value) || value.startsWith('/')) return value;
  // Tavern Helper 的 Character.avatar 通常是角色头像文件名（例如 foo.png）。
  // 组装为 ST 的公开角色头像路径，仍然只保存在本次请求内。
  return `/characters/${encodeURIComponent(value)}`;
}

async function readCharacterAvatar(): Promise<string | null> {
  const character = await getCharacter('current');
  const avatar = character.avatar;
  if (typeof avatar === 'string') {
    const value = normalizePath(avatar);
    return value ? characterAvatarPath(value) : null;
  }
  if (avatar instanceof Blob) return blobToDataUrl(avatar);
  return null;
}

/**
 * 读取当前 persona 与当前角色卡头像。
 *
 * 两个来源独立读取：一个来源缺失或读取失败时，仍保留另一个可用来源。
 * 该函数不写入任何持久化状态，也不输出日志，避免泄露路径或图片数据。
 */
export async function readCurrentAvatarReferences(): Promise<AvatarReferenceReadResult> {
  const references: CurrentAvatarReference[] = [];
  const failedSources: AvatarReferenceSource[] = [];

  try {
    const personaPath = normalizePath(getPersonaAvatarPath('current'));
    if (personaPath) references.push({ source: 'persona', value: personaPath });
  } catch {
    failedSources.push('persona');
  }

  try {
    const characterPath = await readCharacterAvatar();
    if (characterPath) references.push({ source: 'character', value: characterPath });
  } catch {
    failedSources.push('character');
  }

  return { references, failedSources };
}

/** 返回只供图片 API 使用的字符串数组；空来源会被省略。 */
export async function getCurrentAvatarReferenceImages(): Promise<string[]> {
  const { references } = await readCurrentAvatarReferences();
  return references.map(reference => reference.value);
}
