export type ImagePurpose = 'current' | 'prediction' | 'gift';

export type ImagePlacementTarget = {
  kind: 'inline-anchor';
  messageId: number;
  swipeId: number;
  imageIndex: number;
  paragraphIndex: number;
  anchorTextBefore: string;
  anchorTextAfter: string;
};

export type ImageIntent = {
  id: string;
  purpose: ImagePurpose;
  chatId: string;
  prompt: string;
  requestedTarget: ImagePlacementTarget | null;
  createdAt: number;
};

export type ImageIntentInput = Omit<ImageIntent, 'id' | 'createdAt'>;

export type ImageArtifactTarget = {
  messageId: number | null;
  swipeId: number | null;
  imageIndex: number | null;
  giftTaskId?: string;
};

export type ImageArtifact = {
  id: string;
  sourceIntentId: string | null;
  purpose: ImagePurpose;
  origin: 'generated' | 'external';
  chatId: string;
  url: string;
  target: ImageArtifactTarget;
  createdAt: number;
};

export type ImageArtifactInput = Omit<ImageArtifact, 'id' | 'url' | 'createdAt'>;

export const MAX_SAFE_IMAGE_ARTIFACT_DESCRIPTORS = 20;

export type SafeImageArtifactDescriptor = Pick<
  ImageArtifact,
  'id' | 'sourceIntentId' | 'purpose' | 'origin' | 'createdAt'
> & {
  target: Pick<ImageArtifactTarget, 'messageId' | 'swipeId' | 'imageIndex'>;
};

export function toSafeImageArtifactDescriptors(artifacts: ReadonlyArray<ImageArtifact>): SafeImageArtifactDescriptor[] {
  return artifacts.slice(0, MAX_SAFE_IMAGE_ARTIFACT_DESCRIPTORS).map(artifact => ({
    id: artifact.id,
    sourceIntentId: artifact.sourceIntentId,
    purpose: artifact.purpose,
    origin: artifact.origin,
    target: {
      messageId: artifact.target.messageId,
      swipeId: artifact.target.swipeId,
      imageIndex: artifact.target.imageIndex,
    },
    createdAt: artifact.createdAt,
  }));
}

export type ImageArtifactAssociation = { artifactId: string | null };

export function clearArtifactAssociations(
  artifactId: string,
  associations: ReadonlyArray<ImageArtifactAssociation>,
): number {
  let cleared = 0;
  associations.forEach(association => {
    if (association.artifactId !== artifactId) return;
    association.artifactId = null;
    cleared += 1;
  });
  return cleared;
}

let intentSequence = 0;
let artifactSequence = 0;

export function createImageIntent(input: ImageIntentInput): ImageIntent {
  return {
    ...input,
    id: `image-intent-${Date.now()}-${intentSequence++}`,
    requestedTarget: input.requestedTarget ? { ...input.requestedTarget } : null,
    createdAt: Date.now(),
  };
}

export function createImageArtifact(input: ImageArtifactInput, url: string): ImageArtifact {
  return {
    ...input,
    id: `image-artifact-${Date.now()}-${artifactSequence++}`,
    url,
    target: { ...input.target },
    createdAt: Date.now(),
  };
}
