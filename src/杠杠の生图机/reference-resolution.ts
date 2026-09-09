import { ImageApiError, materializeReferenceImage } from './image-api';
import type { ResolvedReferenceSource } from './pipeline-types';
import type { ImageApiProfile } from './settings';

/** Optional sources fail independently; cancellation/timeout stops the entire request. */
export async function materializeReferenceSources(
  sources: readonly ResolvedReferenceSource[],
  profile: ImageApiProfile,
  signal: AbortSignal,
): Promise<ResolvedReferenceSource[]> {
  const resolved: ResolvedReferenceSource[] = [];
  for (const source of sources) {
    if (signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
    try {
      const value = await materializeReferenceImage(source.value, profile, signal);
      if (signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
      resolved.push({ ...source, value });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof ImageApiError && error.timedOut)
      )
        throw error;
      const unreadable =
        error instanceof ImageApiError ||
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'InvalidCharacterError');
      if (!unreadable) throw error;
      // No retries: omit unreadable optional references before assigning image numbers.
    }
  }
  if (signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
  return resolved;
}
