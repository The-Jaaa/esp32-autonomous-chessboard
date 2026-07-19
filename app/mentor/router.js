const express = require('express');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createMentorRouter({ store, service }) {
  const router = express.Router();

  router.get('/conversations', (req, res) => {
    res.json({
      conversations: store.listConversations({
        query: req.query.query,
        limit: req.query.limit
      })
    });
  });

  router.post('/conversations', (req, res) => {
    res.status(201).json({ conversation: store.createConversation(req.body || {}) });
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({ conversation });
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

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[Mentor API]', error);
    return res.status(status).json({ error: error.message || 'Mentor request failed.' });
  });

  return router;
}

module.exports = { createMentorRouter };
