import { ref, type Ref } from 'vue';
import type { ImageArtifact, ImageIntent } from './image-system';

export type PredictionContext = Readonly<{ epoch: number; revision: number; chatId: string }>;
export type PredictionTicket = Readonly<PredictionContext & { intentId: string }>;
export type PredictionCandidate = Readonly<{
  intent: Readonly<ImageIntent>;
  artifactId: string | null;
  ticket: PredictionTicket;
}>;
export type PredictionSlotStatus = 'empty' | 'intent' | 'ready';
export type PredictionArtifactOwner = Readonly<{ intentId: string; chatId: string }>;
export type PredictionSlotOptions = {
  onDiscardArtifact?: (artifactId: string, owner: PredictionArtifactOwner) => void;
};

export function isPredictionContextCurrent(expected: PredictionContext, current: PredictionContext): boolean {
  return (
    expected.epoch === current.epoch && expected.revision === current.revision && expected.chatId === current.chatId
  );
}

export function canReplacePrediction(
  intent: Pick<ImageIntent, 'purpose' | 'chatId'>,
  expected: PredictionContext,
  current: PredictionContext,
): boolean {
  return (
    intent.purpose === 'prediction' &&
    intent.chatId === expected.chatId &&
    intent.chatId === current.chatId &&
    isPredictionContextCurrent(expected, current)
  );
}

export function isPredictionArtifactOwnedBy(
  artifact: Pick<ImageArtifact, 'purpose' | 'chatId' | 'sourceIntentId'> | null | undefined,
  owner: PredictionArtifactOwner,
): boolean {
  return (
    artifact?.purpose === 'prediction' && artifact.chatId === owner.chatId && artifact.sourceIntentId === owner.intentId
  );
}

function freezeIntent(intent: ImageIntent): Readonly<ImageIntent> {
  const requestedTarget = intent.requestedTarget ? Object.freeze({ ...intent.requestedTarget }) : null;
  return Object.freeze({ ...intent, requestedTarget });
}

export class PredictionSlot {
  private readonly candidate: Ref<PredictionCandidate | null> = ref(null);
  private revisionValue = 0;

  constructor(private readonly options: PredictionSlotOptions = {}) {}

  get revision(): number {
    return this.revisionValue;
  }

  get status(): PredictionSlotStatus {
    const candidate = this.candidate.value;
    return candidate ? (candidate.artifactId ? 'ready' : 'intent') : 'empty';
  }

  replace(intent: ImageIntent, epoch: number, artifactId: string | null = null): PredictionCandidate {
    if (intent.purpose !== 'prediction') throw new Error('PredictionSlot 只接受 prediction intent');
    const previous = this.candidate.value;
    this.revisionValue += 1;
    const frozenIntent = freezeIntent(intent);
    const ticket = Object.freeze({
      epoch,
      revision: this.revisionValue,
      chatId: frozenIntent.chatId,
      intentId: frozenIntent.id,
    });
    const next = Object.freeze({ intent: frozenIntent, artifactId, ticket });
    this.candidate.value = next;
    if (previous?.artifactId && previous.artifactId !== artifactId) {
      this.options.onDiscardArtifact?.(previous.artifactId, previous.ticket);
    }
    return next;
  }

  attach(ticket: PredictionTicket, artifactId: string): PredictionCandidate | null {
    const current = this.candidate.value;
    if (!current || !artifactId || !this.matches(ticket)) return null;
    const next = Object.freeze({ ...current, artifactId });
    this.candidate.value = next;
    if (current.artifactId && current.artifactId !== artifactId) {
      this.options.onDiscardArtifact?.(current.artifactId, current.ticket);
    }
    return next;
  }

  peek(): PredictionCandidate | null {
    return this.candidate.value;
  }

  consume(ticket?: PredictionTicket): PredictionCandidate | null {
    const current = this.candidate.value;
    if (!current || (ticket && !this.matches(ticket))) return null;
    this.candidate.value = null;
    this.revisionValue += 1;
    return current;
  }

  drop(ticket?: PredictionTicket): boolean {
    const current = this.candidate.value;
    if (!current || (ticket && !this.matches(ticket))) return false;
    this.candidate.value = null;
    this.revisionValue += 1;
    if (current.artifactId) this.options.onDiscardArtifact?.(current.artifactId, current.ticket);
    return true;
  }

  invalidateArtifact(artifactId: string): boolean {
    if (this.candidate.value?.artifactId !== artifactId) return false;
    this.candidate.value = null;
    this.revisionValue += 1;
    return true;
  }

  matches(ticket: PredictionTicket): boolean {
    const current = this.candidate.value?.ticket;
    return Boolean(
      current &&
      current.epoch === ticket.epoch &&
      current.revision === ticket.revision &&
      current.chatId === ticket.chatId &&
      current.intentId === ticket.intentId,
    );
  }
}
