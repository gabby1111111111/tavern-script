export type ImageRetentionScope = {
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
};

export type ImageRetentionSelectionKind = 'auto' | 'manual';

export type ImageRetentionSelection = ImageRetentionScope & {
  placementId: string;
  kind: ImageRetentionSelectionKind;
  sequence: number;
};

export type ImageRetentionLivePlacement = {
  id: string;
  scope: ImageRetentionScope;
};

type ManualSelection = {
  placementId: string;
  sequence: number;
};

export function imageRetentionScopeKey(scope: ImageRetentionScope): string {
  return `${scope.chatId}::${scope.messageId}::${scope.swipeId}::${scope.imageIndex}`;
}

export function imageRetentionMessageImageKey(scope: ImageRetentionScope): string {
  return `${scope.chatId}::${scope.messageId}::${scope.imageIndex}`;
}

export function imageRetentionScopeForPlacement(
  chatId: string,
  placement: { target: Pick<ImageRetentionScope, 'messageId' | 'swipeId' | 'imageIndex'> },
): ImageRetentionScope {
  return {
    chatId,
    messageId: placement.target.messageId,
    swipeId: placement.target.swipeId,
    imageIndex: placement.target.imageIndex,
  };
}

/**
 * Page-memory selection state for one story-image runtime. It is deliberately
 * separate from settings and the recent-image cache. Placement ids are the
 * source of truth for manual pins, so message/swipe index shifts cannot leave
 * a stale scope index behind.
 */
export class ImageRetention {
  private readonly manualSelections = new Map<string, ManualSelection>();
  private readonly pinnedPlacementIds = new Set<string>();
  private readonly versionByScope = new Map<string, number>();
  private readonly deferredScopes = new Set<string>();
  private sequence = 0;

  rememberAuto(_scope: ImageRetentionScope, placementId: string): void {
    this.pinnedPlacementIds.add(placementId);
  }

  pin(scope: ImageRetentionScope, placementId: string): ImageRetentionSelection {
    const sequence = ++this.sequence;
    this.manualSelections.set(placementId, { placementId, sequence });
    this.pinnedPlacementIds.add(placementId);
    return { ...scope, placementId, kind: 'manual', sequence };
  }

  latestManualSelection(
    scope: Pick<ImageRetentionScope, 'chatId' | 'messageId' | 'imageIndex'>,
    livePlacements: ReadonlyArray<ImageRetentionLivePlacement>,
  ): ImageRetentionSelection | undefined {
    let latest: { placement: ImageRetentionLivePlacement; sequence: number } | undefined;
    livePlacements.forEach(placement => {
      if (
        placement.scope.chatId !== scope.chatId ||
        placement.scope.messageId !== scope.messageId ||
        placement.scope.imageIndex !== scope.imageIndex
      )
        return;
      const manual = this.manualSelections.get(placement.id);
      if (!manual || (latest && manual.sequence <= latest.sequence)) return;
      latest = { placement, sequence: manual.sequence };
    });
    return latest
      ? {
          ...latest.placement.scope,
          placementId: latest.placement.id,
          kind: 'manual',
          sequence: latest.sequence,
        }
      : undefined;
  }

  isPinned(placementId: string): boolean {
    return this.pinnedPlacementIds.has(placementId);
  }

  token(scope: ImageRetentionScope): number {
    return this.versionByScope.get(imageRetentionScopeKey(scope)) ?? 0;
  }

  invalidate(scope: ImageRetentionScope): number {
    const key = imageRetentionScopeKey(scope);
    const next = (this.versionByScope.get(key) ?? 0) + 1;
    this.versionByScope.set(key, next);
    return next;
  }

  forgetScope(scope: ImageRetentionScope): void {
    const key = imageRetentionScopeKey(scope);
    this.versionByScope.delete(key);
    this.deferredScopes.delete(key);
  }

  moveScope(from: ImageRetentionScope, to: ImageRetentionScope): void {
    const fromKey = imageRetentionScopeKey(from);
    const toKey = imageRetentionScopeKey(to);
    if (fromKey === toKey) return;

    const fromVersion = this.versionByScope.get(fromKey);
    if (fromVersion !== undefined) {
      const toVersion = this.versionByScope.get(toKey);
      this.versionByScope.set(toKey, Math.max(fromVersion, toVersion ?? 0));
    }
    this.versionByScope.delete(fromKey);

    if (this.deferredScopes.delete(fromKey)) this.deferredScopes.add(toKey);
  }

  defer(scope: ImageRetentionScope): void {
    this.deferredScopes.add(imageRetentionScopeKey(scope));
  }

  isDeferred(scope: ImageRetentionScope): boolean {
    return this.deferredScopes.has(imageRetentionScopeKey(scope));
  }

  consumeDeferred(scope: ImageRetentionScope): boolean {
    return this.deferredScopes.delete(imageRetentionScopeKey(scope));
  }

  forgetPlacement(placementId: string): void {
    this.pinnedPlacementIds.delete(placementId);
    this.manualSelections.delete(placementId);
  }

  clear(): void {
    this.manualSelections.clear();
    this.pinnedPlacementIds.clear();
    this.versionByScope.clear();
    this.deferredScopes.clear();
    this.sequence = 0;
  }
}
