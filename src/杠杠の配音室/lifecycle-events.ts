export type VoiceLifecycleStopReason = 'chat-change' | 'message-swipe' | 'message-edit' | 'message-delete';

export type VoiceLifecycleActions = {
  stopAll: (reason: VoiceLifecycleStopReason) => void;
  clearAllMessageState: () => void;
  clearMessageState: (messageId: number) => void;
  scheduleCharacterRefresh: () => void;
  renderMessage: (messageId: number) => void;
};

export type VoiceLifecycleHandlers = {
  chatChanged: () => void;
  messageSwiped: (messageId: unknown) => void;
  messageEdited: (messageId: unknown) => void;
  messageDeleted: (messageId: unknown) => void;
};

export type VoiceLifecycleRegistrar<Subscription> = {
  onChatChanged: (listener: VoiceLifecycleHandlers['chatChanged']) => Subscription;
  onMessageSwiped: (listener: VoiceLifecycleHandlers['messageSwiped']) => Subscription;
  onMessageEdited: (listener: VoiceLifecycleHandlers['messageEdited']) => Subscription;
  onMessageDeleted: (listener: VoiceLifecycleHandlers['messageDeleted']) => Subscription;
};

export function createVoiceLifecycleHandlers(actions: VoiceLifecycleActions): VoiceLifecycleHandlers {
  const handleMessageChange = (
    reason: Extract<VoiceLifecycleStopReason, 'message-swipe' | 'message-edit'>,
    messageId: unknown,
  ): void => {
    actions.stopAll(reason);
    const normalizedMessageId = Number(messageId);
    actions.clearMessageState(normalizedMessageId);
    actions.renderMessage(normalizedMessageId);
  };

  return {
    chatChanged: () => {
      actions.stopAll('chat-change');
      actions.clearAllMessageState();
      actions.scheduleCharacterRefresh();
    },
    messageSwiped: messageId => handleMessageChange('message-swipe', messageId),
    messageEdited: messageId => handleMessageChange('message-edit', messageId),
    messageDeleted: () => {
      actions.stopAll('message-delete');
      actions.clearAllMessageState();
    },
  };
}

export function bindVoiceLifecycleEvents<Subscription>(
  registrar: VoiceLifecycleRegistrar<Subscription>,
  actions: VoiceLifecycleActions,
): Subscription[] {
  const handlers = createVoiceLifecycleHandlers(actions);
  return [
    registrar.onChatChanged(handlers.chatChanged),
    registrar.onMessageSwiped(handlers.messageSwiped),
    registrar.onMessageEdited(handlers.messageEdited),
    registrar.onMessageDeleted(handlers.messageDeleted),
  ];
}
