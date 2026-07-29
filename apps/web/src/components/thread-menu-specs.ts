import type { Message, Thread } from '@writing-studio/contract';
import { withDisabledReason, type ContextMenuSpec } from './ContextMenu.js';

export interface MessageMenuActions {
  copyContent(content: string): void | Promise<void>;
  quoteContent(content: string): void;
  openRewriteReview(messageId: string): void;
}

export interface ThreadMenuActions {
  open(threadId: string): void | Promise<void>;
  rename(thread: Thread): void;
  copyTranscript(threadId: string): void | Promise<void>;
}

/** Pure message spec factory. Role-specific item counts intentionally mirror §3.3. */
export function createMessageMenuSpec(
  message: Message,
  options: {
    running: boolean;
    canReviewRewrite: boolean;
    actions: MessageMenuActions;
  },
): ContextMenuSpec {
  const items: ContextMenuSpec['items'] = [
    withDisabledReason({
      id: 'copy-message',
      label: '复制内容',
      disabled: message.content.trim().length === 0,
      onSelect: () => options.actions.copyContent(message.content),
    }, message.content.trim().length === 0 ? '消息内容为空' : undefined),
    withDisabledReason({
      id: 'quote-message',
      label: '引用到输入框',
      disabled: options.running,
      onSelect: () => options.actions.quoteContent(message.content),
    }, options.running ? 'AI 运行中，无法引用消息' : undefined),
  ];

  if (message.role === 'assistant') {
    items.push(
      { id: 'message-rewrite-separator', separator: true },
      withDisabledReason({
        id: 'review-rewrite',
        label: '查看改写并应用…',
        disabled: !options.canReviewRewrite,
        onSelect: () => options.actions.openRewriteReview(message.id),
      }, options.canReviewRewrite ? undefined : '该消息没有可查看的改写结果'),
    );
  }

  return { label: `${message.role === 'user' ? '我的消息' : 'AI 消息'} · 操作`, items };
}

/** Pure thread-list spec factory. Archive/resolve is deliberately absent after O1. */
export function createThreadMenuSpec(
  thread: Thread,
  options: {
    activeThreadId: string | undefined;
    running: boolean;
    actions: ThreadMenuActions;
  },
): ContextMenuSpec {
  const isActive = thread.id === options.activeThreadId;
  return {
    label: `${thread.title} · 操作`,
    items: [
      withDisabledReason({
        id: 'open-thread',
        label: '打开',
        disabled: isActive || options.running,
        onSelect: () => options.actions.open(thread.id),
      }, isActive ? '当前已是此线程' : options.running ? 'AI 运行中，无法切换线程' : undefined),
      withDisabledReason({
        id: 'rename-thread',
        label: '重命名线程…',
        disabled: options.running && isActive,
        onSelect: () => options.actions.rename(thread),
      }, options.running && isActive ? 'AI 运行中，无法重命名当前线程' : undefined),
      { id: 'thread-copy-separator', separator: true },
      {
        id: 'copy-thread',
        label: '复制线程全文',
        onSelect: () => options.actions.copyTranscript(thread.id),
      },
    ],
  };
}
