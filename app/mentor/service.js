function validateRequestId(requestId) {
  return typeof requestId === 'string'
    && requestId.length >= 1
    && requestId.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(requestId);
}

function validateMessageText(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 8000;
}

class MentorService {
  constructor({ store, provider, contextProvider = null, emit = () => {} }) {
    this.store = store;
    this.provider = provider;
    this.contextProvider = contextProvider;
    this.emit = emit;
    this.active = new Map();
  }

  key(conversationId, requestId) {
    return `${conversationId}:${requestId}`;
  }

  submitMessage(conversationId, { requestId, text }) {
    if (!validateRequestId(requestId)) {
      const error = new Error('requestId must contain 1-128 letters, numbers, dots, colons, dashes, or underscores.');
      error.statusCode = 400;
      throw error;
    }
    if (!validateMessageText(text)) {
      const error = new Error('Message text must contain 1-8000 characters.');
      error.statusCode = 400;
      throw error;
    }

    const pair = this.store.createMessagePair(conversationId, {
      requestId,
      text: text.trim()
    });
    if (!pair) {
      const error = new Error('Conversation not found.');
      error.statusCode = 404;
      throw error;
    }

    const activeKey = this.key(conversationId, requestId);
    if (!pair.duplicate && !this.active.has(activeKey)) {
      const controller = new AbortController();
      const active = {
        controller,
        assistantMessageId: pair.assistantMessage.id,
        cancellationEmitted: false
      };
      this.active.set(activeKey, active);
      queueMicrotask(() => this.runStream(conversationId, requestId, pair.assistantMessage, active));
    }

    return pair;
  }

  async runStream(conversationId, requestId, assistantMessage, active) {
    const activeKey = this.key(conversationId, requestId);
    const { controller } = active;
    this.store.setMessageStatus(assistantMessage.id, 'streaming');
    this.emit(conversationId, 'mentor-message-start', {
      conversationId,
      requestId,
      message: this.store.getMessage(assistantMessage.id)
    });

    try {
      const messages = this.store.contextMessages(conversationId, 24000)
        .filter((message) => message.content);
      const chessContext = this.contextProvider ? this.contextProvider(conversationId) : null;
      for await (const delta of this.provider.stream({
        messages,
        chessContext,
        signal: controller.signal
      })) {
        if (controller.signal.aborted) break;
        this.store.appendMessageContent(assistantMessage.id, delta);
        this.emit(conversationId, 'mentor-message-delta', {
          conversationId,
          requestId,
          messageId: assistantMessage.id,
          delta
        });
      }

      if (controller.signal.aborted) {
        if (!active.cancellationEmitted) this.emitCancellation(conversationId, requestId, active);
        return;
      }

      const message = this.store.setMessageStatus(assistantMessage.id, 'complete');
      const conversation = this.store.touchConversation(conversationId);
      this.emit(conversationId, 'mentor-message-complete', {
        conversationId,
        requestId,
        message,
        conversation
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!active.cancellationEmitted) this.emitCancellation(conversationId, requestId, active);
      } else {
        const message = this.store.setMessageStatus(assistantMessage.id, 'failed');
        this.emit(conversationId, 'mentor-message-failed', {
          conversationId,
          requestId,
          message,
          error: error.message
        });
      }
    } finally {
      this.active.delete(activeKey);
    }
  }

  emitCancellation(conversationId, requestId, active) {
    const message = this.store.setMessageStatus(active.assistantMessageId, 'cancelled');
    active.cancellationEmitted = true;
    this.emit(conversationId, 'mentor-message-cancelled', {
      conversationId,
      requestId,
      message
    });
  }

  cancel(conversationId, requestId) {
    const active = this.active.get(this.key(conversationId, requestId));
    if (!active) return false;
    active.controller.abort();
    if (!active.cancellationEmitted) this.emitCancellation(conversationId, requestId, active);
    return true;
  }

  cancelConversation(conversationId) {
    let cancelled = 0;
    for (const [key, active] of this.active.entries()) {
      if (key.startsWith(`${conversationId}:`)) {
        active.controller.abort();
        cancelled += 1;
      }
    }
    return cancelled;
  }
}

module.exports = {
  MentorService,
  validateMessageText,
  validateRequestId
};
