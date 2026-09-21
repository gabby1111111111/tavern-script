/** Page-memory view model. Never write these image URLs or prompts to audit/settings. */
export type WorkbenchImage = {
  id: string;
  url: string;
  prompt: string;
  variantIndex: number;
  revisionIndex: number;
  referenceSource?: { messageId: number; swipeId: number; imageIndex: number } | null;
};

export type WorkbenchShot = {
  id: string;
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
  basePlacementId: string | null;
  confirmedPlacementId: string | null;
  shotPrompt: string;
  images: WorkbenchImage[];
  pendingCount: number;
  status: 'pending' | 'unconfirmed' | 'confirmed' | 'failed';
};
