const express = require('express');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createMentorRouter({ store, service, chessService, emitBoardUpdate = () => {} }) {
  const router = express.Router();
  const withToolCalls = (conversation) => {
    const toolCalls = store.listToolCalls(conversation.id);
    return {
      ...conversation,
      messages: (conversation.messages || []).map((message) => ({
        ...message,
        toolCalls: toolCalls.filter((toolCall) => toolCall.assistantMessageId === message.id)
      }))
    };
  };

  router.get('/conversations', (req, res) => {
    res.json({
      conversations: store.listConversations({
        query: req.query.query,
        limit: req.query.limit
      })
    });
  });

  router.post('/conversations', (req, res) => {
    const conversation = store.createConversation(req.body || {});
    res.status(201).json({
      conversation: {
        ...conversation,
        messages: [],
        chess: chessService.getState(conversation.id)
      }
    });
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({
      conversation: {
        ...withToolCalls(conversation),
        chess: chessService.getState(conversation.id)
      }
    });
  });

  router.patch('/conversations/:id', (req, res) => {
    if (!store.getConversation(req.params.id)) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    const conversation = store.updateConversation(req.params.id, { title: req.body?.title });
    if (!conversation) return res.status(400).json({ error: 'A valid title is required.' });
    return res.json({ conversation });
  });

  router.delete('/conversations/:id', (req, res) => {
    service.cancelConversation(req.params.id);
    if (!store.deleteConversation(req.params.id)) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    return res.status(204).end();
  });

  router.post('/conversations/:id/messages', asyncRoute(async (req, res) => {
    const result = service.submitMessage(req.params.id, req.body || {});
    return res.status(result.duplicate ? 200 : 202).json({
      duplicate: result.duplicate,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage
    });
  }));

  const commitBoardAction = (handler) => (req, res, next) => {
    try {
      const result = handler(req);
      emitBoardUpdate(req.params.id, result);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  };

  router.post('/conversations/:id/moves', commitBoardAction((req) =>
    chessService.move(req.params.id, req.body || {})));

  router.put('/conversations/:id/position', commitBoardAction((req) =>
    chessService.setPosition(req.params.id, req.body || {})));

  router.post('/conversations/:id/reset', commitBoardAction((req) =>
    chessService.reset(req.params.id, req.body || {})));

  router.patch('/conversations/:id/board', commitBoardAction((req) =>
    chessService.setOrientation(req.params.id, req.body || {})));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[Mentor API]', error);
    return res.status(status).json({
      error: error.message || 'Mentor request failed.',
      code: error.code,
      state: error.state
    });
  });

  return router;
}

module.exports = { createMentorRouter };
