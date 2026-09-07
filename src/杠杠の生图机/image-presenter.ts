import type { DisplayMode } from './pipeline-types';
import type { ImageResource } from './image-api';
import { ImagePlacementCache, type ImagePlacement } from './image-placement';
import { RecentImageCache, type RecentGeneratedImage } from './recent-image-cache';
import type { ImageArtifact, ImageArtifactInput, ImageArtifactTarget, ImagePlacementTarget } from './image-system';

export type ImagePresentationInput = {
  resource: ImageResource;
  chatId: string;
  sourceIntentId?: string | null;
  origin?: ImageArtifactInput['origin'];
  displayMode: DisplayMode;
  /** Required for inline output; gift output deliberately has no placement target. */
  placementTarget?: ImagePlacementTarget;
  /** Optional metadata for recent-image consumers. */
  artifactTarget?: Partial<ImageArtifactTarget>;
  /** Raw page-memory chat object used to reconcile messageId after a floor is deleted. */
  messageRef?: object | null;
  /** Zero-based result position when one API request returns multiple images. */
  variantIndex?: number;
  revisionIndex?: number;
  /** Page-memory source prompt used by manual redraw/edit actions. */
  prompt?: string;
  caption?: string;
};

export type ImagePresentation = {
  mode: DisplayMode;
  artifact: ImageArtifact;
  recentImage: RecentGeneratedImage;
  placement: ImagePlacement | null;
};

export type ImagePresentationContext = {
  recentCache: RecentImageCache;
  placementCache: ImagePlacementCache;
};

function artifactTarget(input: ImagePresentationInput): ImageArtifactTarget {
  const placement = input.placementTarget;
  return {
    messageId: input.artifactTarget?.messageId ?? placement?.messageId ?? null,
    swipeId: input.artifactTarget?.swipeId ?? placement?.swipeId ?? null,
    imageIndex: input.artifactTarget?.imageIndex ?? placement?.imageIndex ?? null,
    ...(input.artifactTarget?.giftTaskId ? { giftTaskId: input.artifactTarget.giftTaskId } : {}),
  };
}

/**
 * Move a generated resource into the page-memory pipeline and choose its
 * presentation mode.  This function does not touch chat source text and does
 * not emit a toast; runtime owns those lifecycle and notification decisions.
 */
export function presentGeneratedImage(
  context: ImagePresentationContext,
  input: ImagePresentationInput,
): ImagePresentation | null {
  if (!input.chatId.trim() || !input.resource.url.trim()) return null;
  if (input.displayMode === 'inline' && !input.placementTarget) return null;

  const artifact = context.recentCache.add(
    {
      sourceIntentId: input.sourceIntentId ?? null,
      purpose: input.displayMode === 'gift' ? 'gift' : 'current',
      origin: input.origin ?? 'generated',
      chatId: input.chatId,
      target: artifactTarget(input),
    },
    input.resource,
    input.messageRef,
  );
  if (!artifact) return null;

  let placement: ImagePlacement | null = null;
  if (input.displayMode === 'inline') {
    placement = context.placementCache.place({
      artifactId: artifact.id,
      target: input.placementTarget!,
      caption: input.caption,
      variantIndex: input.variantIndex,
      revisionIndex: input.revisionIndex,
      prompt: input.prompt,
      messageRef: input.messageRef,
    });
    if (!placement) {
      // An artifact without a renderable inline owner is not useful and would
      // otherwise occupy the bounded recent pool until eviction.
      context.recentCache.remove(artifact.id);
      return null;
    }
  }

  const recentImage = context.recentCache.images.value.find(image => image.id === artifact.id);
  if (!recentImage) {
    if (placement) context.placementCache.remove(placement.id);
    context.recentCache.remove(artifact.id);
    return null;
  }

  return {
    mode: input.displayMode,
    artifact,
    recentImage,
    placement,
  };
}

export class ImagePresenter {
  constructor(private readonly context: ImagePresentationContext) {}

  present(input: ImagePresentationInput): ImagePresentation | null {
    return presentGeneratedImage(this.context, input);
  }
}
