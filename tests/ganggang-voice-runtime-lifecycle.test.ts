import { bindVoiceLifecycleEvents, type VoiceLifecycleHandlers } from '../src/杠杠の配音台/lifecycle-events';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const callbacks: Partial<VoiceLifecycleHandlers> = {};
const registrations: string[] = [];
const trace: string[] = [];

const subscriptions = bindVoiceLifecycleEvents(
  {
    onChatChanged: listener => {
      registrations.push('chat-changed');
      callbacks.chatChanged = listener;
      return 'chat-subscription';
    },
    onMessageSwiped: listener => {
      registrations.push('message-swiped');
      callbacks.messageSwiped = listener;
      return 'swipe-subscription';
    },
    onMessageEdited: listener => {
      registrations.push('message-edited');
      callbacks.messageEdited = listener;
      return 'edit-subscription';
    },
    onMessageDeleted: listener => {
      registrations.push('message-deleted');
      callbacks.messageDeleted = listener;
      return 'delete-subscription';
    },
  },
  {
    stopAll: reason => trace.push(`stop:${reason}`),
    clearAllMessageState: () => trace.push('clear-all'),
    clearMessageState: messageId => trace.push(`clear-message:${messageId}`),
    scheduleCharacterRefresh: () => trace.push('schedule-character-refresh'),
    renderMessage: messageId => trace.push(`render-message:${messageId}`),
  },
);

equal(
  registrations,
  ['chat-changed', 'message-swiped', 'message-edited', 'message-deleted'],
  'binder 应注册全部四种 Tavern 宿主事件',
);
equal(
  subscriptions,
  ['chat-subscription', 'swipe-subscription', 'edit-subscription', 'delete-subscription'],
  'binder 应把四个可释放订阅按注册顺序返回给 runtime',
);

assert(callbacks.chatChanged, 'CHAT_CHANGED listener 未注册');
callbacks.chatChanged();
equal(
  trace.splice(0),
  ['stop:chat-change', 'clear-all', 'schedule-character-refresh'],
  '换聊天必须先 Stop，再清空楼层状态，最后安排角色刷新',
);

assert(callbacks.messageSwiped, 'MESSAGE_SWIPED listener 未注册');
callbacks.messageSwiped('12');
equal(
  trace.splice(0),
  ['stop:message-swipe', 'clear-message:12', 'render-message:12'],
  '重抽必须先 Stop，只清目标楼层，再重绘该楼层',
);

assert(callbacks.messageEdited, 'MESSAGE_EDITED listener 未注册');
callbacks.messageEdited(13);
equal(
  trace.splice(0),
  ['stop:message-edit', 'clear-message:13', 'render-message:13'],
  '编辑必须先 Stop，只清目标楼层，再重绘该楼层',
);

assert(callbacks.messageDeleted, 'MESSAGE_DELETED listener 未注册');
callbacks.messageDeleted(14);
equal(trace.splice(0), ['stop:message-delete', 'clear-all'], '删除楼层必须先 Stop，再清空所有楼层派生状态');

console.info('<杠杠の配音台> runtime lifecycle tests passed');
