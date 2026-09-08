import type { RecentVoiceStatus, SoundCue, SpokenSegment } from './types';

export type MessageDecoration = {
  segments: SpokenSegment[];
  soundCues: SoundCue[];
};

export type MessageControlOptions = {
  resolveMessage: (messageId: number, message: string) => MessageDecoration;
  onPlayMessage: (messageId: number, segments: SpokenSegment[]) => void | Promise<void>;
  onPlaySegment: (segment: SpokenSegment) => void | Promise<void>;
  onPlaySelection: (messageId: number, text: string, segments: SpokenSegment[]) => void | Promise<void>;
  onPlaySoundEffect: (cue: SoundCue) => void | Promise<void>;
  getSegmentStatus?: (segment: SpokenSegment) => RecentVoiceStatus | null;
};

const CONTROL_CLASS = 'ganggang-voice-control';

function iconButton(ownerDocument: Document, label: string, iconClass: string): HTMLButtonElement {
  const button = ownerDocument.createElement('button');
  button.type = 'button';
  button.className = `${CONTROL_CLASS} menu_button interactable`;
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = ownerDocument.createElement('i');
  icon.className = iconClass;
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  return button;
}

function placeNearText(
  root: HTMLElement,
  anchorText: string,
  control: HTMLElement,
  placement: 'before' | 'after' = 'after',
  occurrence = 0,
): boolean {
  const anchor = anchorText.trim();
  if (!anchor) return false;
  const ownerDocument = root.ownerDocument;
  const walker = ownerDocument.createTreeWalker(root, 4);
  let remaining = Math.max(0, occurrence);
  let node: Node | null = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    const value = node.textContent ?? '';
    if (parent && !parent.closest(`.${CONTROL_CLASS}`)) {
      let from = 0;
      let index = value.indexOf(anchor, from);
      while (index >= 0) {
        if (remaining === 0) {
          const range = ownerDocument.createRange();
          range.setStart(node, placement === 'before' ? index : index + anchor.length);
          range.collapse(true);
          range.insertNode(control);
          return true;
        }
        remaining -= 1;
        from = index + anchor.length;
        index = value.indexOf(anchor, from);
      }
    }
    node = walker.nextNode();
  }
  return false;
}

function runAction(action: () => void | Promise<void>): void {
  Promise.resolve()
    .then(action)
    .catch(error =>
      console.error(
        '<杠杠の配音室> 消息按钮操作失败',
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      ),
    );
}

function textOccurrenceCount(text: string, anchor: string): number {
  if (!anchor) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(anchor, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(1, anchor.length);
  }
  return count;
}

function cueDisplayOccurrence(cue: SoundCue, segments: readonly SpokenSegment[], fallback: number): number {
  if (!cue.sourceSegmentId) return fallback;
  let occurrence = 0;
  for (const segment of segments) {
    if (segment.id === cue.sourceSegmentId) return occurrence + Math.max(0, cue.anchorOccurrence);
    occurrence += textOccurrenceCount(segment.text, cue.anchorText);
  }
  return fallback;
}

function segmentButtonState(status: RecentVoiceStatus | null): { label: string; icon: string; busy: boolean } {
  if (status === 'generating') return { label: '语音生成中', icon: 'fa-solid fa-spinner fa-spin', busy: true };
  if (status === 'playing') return { label: '暂停这句对白', icon: 'fa-solid fa-pause', busy: false };
  if (status === 'ready' || status === 'paused') {
    return { label: '播放这句对白', icon: 'fa-solid fa-play', busy: false };
  }
  return { label: '准备并朗读这句对白', icon: 'fa-solid fa-headphones', busy: false };
}

export class MessageControlManager {
  private readonly listeners: EventOnReturn[] = [];
  private destroyed = false;

  constructor(private readonly options: MessageControlOptions) {}

  start(): void {
    this.listeners.push(
      eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, messageId => this.renderMessage(Number(messageId))),
      eventOn(tavern_events.USER_MESSAGE_RENDERED, messageId => this.renderMessage(Number(messageId))),
      eventOn(tavern_events.MESSAGE_EDITED, messageId => this.renderMessage(Number(messageId))),
      eventOn(tavern_events.MESSAGE_SWIPED, messageId => this.renderMessage(Number(messageId))),
      eventOn(tavern_events.MESSAGE_DELETED, () => this.renderAllSoon()),
      eventOn(tavern_events.MORE_MESSAGES_LOADED, () => this.renderAllSoon()),
      eventOn(tavern_events.CHAT_CHANGED, () => this.renderAllSoon()),
    );
    this.renderAllSoon();
  }

  renderMessage(messageId: number): void {
    if (this.destroyed || !Number.isFinite(messageId)) return;
    const message = getChatMessages(messageId, { include_swipes: false })[0];
    const root = retrieveDisplayedMessage(messageId)[0];
    const floor = $<HTMLElement>(`#chat .mes[mesid="${messageId}"]`)[0];
    if (!message || !root || !floor || message.is_hidden || message.role === 'system') return;

    floor.querySelectorAll(`.${CONTROL_CLASS}`).forEach(element => element.remove());
    const decoration = this.options.resolveMessage(messageId, message.message);
    this.addFloorControls(floor, messageId, decoration.segments);

    const dialogueOccurrences = new Map<string, number>();
    decoration.segments
      .filter(segment => segment.kind === 'dialogue')
      .forEach(segment => {
        const buttonState = segmentButtonState(this.options.getSegmentStatus?.(segment) ?? null);
        const button = iconButton(
          floor.ownerDocument,
          `${buttonState.label}：${segment.characterName ?? '对白'}`,
          buttonState.icon,
        );
        button.classList.add('ganggang-voice-dialogue');
        button.setAttribute('aria-busy', String(buttonState.busy));
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          runAction(() => this.options.onPlaySegment(segment));
        });
        const occurrence = dialogueOccurrences.get(segment.text) ?? 0;
        if (placeNearText(root, segment.text, button, 'after', occurrence)) {
          dialogueOccurrences.set(segment.text, occurrence + 1);
        }
      });

    const cueOccurrences = new Map<string, number>();
    decoration.soundCues.forEach(cue => {
      const button = iconButton(floor.ownerDocument, '播放场景音效', 'fa-solid fa-volume-high');
      button.classList.add('ganggang-voice-sound-effect');
      button.setAttribute('data-testid', 'ganggang-voice-inline-sfx');
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runAction(() => this.options.onPlaySoundEffect(cue));
      });
      const occurrence = cueDisplayOccurrence(cue, decoration.segments, cueOccurrences.get(cue.anchorText) ?? 0);
      if (placeNearText(root, cue.anchorText, button, cue.placement, occurrence)) {
        cueOccurrences.set(cue.anchorText, occurrence + 1);
      }
    });
  }

  renderAll(): void {
    if (this.destroyed) return;
    $('#chat .mes[mesid]').each((_, element) => this.renderMessage(Number(element.getAttribute('mesid'))));
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.splice(0).forEach(listener => listener.stop());
    $(`.${CONTROL_CLASS}`).remove();
  }

  private addFloorControls(floor: HTMLElement, messageId: number, segments: SpokenSegment[]): void {
    const target = floor.querySelector<HTMLElement>('.mes_buttons, .mes_block .mes_buttons') ?? floor;
    const playMessage = iconButton(floor.ownerDocument, '朗读本条消息', 'fa-solid fa-headphones');
    playMessage.classList.add('ganggang-voice-message');
    playMessage.setAttribute('data-testid', 'ganggang-voice-message-read');
    playMessage.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      runAction(() => this.options.onPlayMessage(messageId, segments));
    });
    target.append(playMessage);

    const playSelection = iconButton(floor.ownerDocument, '朗读当前选中文本', 'fa-solid fa-i-cursor');
    playSelection.classList.add('ganggang-voice-selection');
    playSelection.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const text = floor.ownerDocument.defaultView?.getSelection()?.toString().trim() ?? '';
      if (text) runAction(() => this.options.onPlaySelection(messageId, text, segments));
    });
    target.append(playSelection);
  }

  private renderAllSoon(): void {
    window.setTimeout(() => this.renderAll(), 0);
  }
}
