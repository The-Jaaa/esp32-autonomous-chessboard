const express = require('express');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createMentorRouter({ store, service, chessService, activityService, liveService, emitBoardUpdate = () => {} }) {
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
        chess: chessService.getState(conversation.id),
        activity: activityService?.get(conversation.id) || null
      }
    });
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    return res.json({
      conversation: {
        ...withToolCalls(conversation),
        chess: chessService.getState(conversation.id),
        activity: activityService?.get(conversation.id) || null
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

  router.delete('/conversations/:id', asyncRoute(async (req, res) => {
    service.cancelConversation(req.params.id);
    await liveService?.stopConversation(req.params.id, 'conversation_deleted');
    if (!store.deleteConversation(req.params.id)) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    return res.status(204).end();
  }));

  router.post('/conversations/:id/messages', asyncRoute(async (req, res) => {
    if (liveService?.isConversationActive(req.params.id)) {
      const error = new Error('Send typed messages through the active Live mentor session.');
      error.statusCode = 409;
      error.code = 'mentor_live_active';
      throw error;
    }
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

  router.post('/conversations/:id/moves', (req, res, next) => {
    try {
      const active = activityService?.validateLearnerMove(req.params.id, req.body || {});
      const result = chessService.move(req.params.id, {
        ...(req.body || {}),
        actor: active ? 'learner' : 'unknown',
        activityId: active?.id || null
      });
      activityService?.learnerMoveCommitted(req.params.id, result);
      emitBoardUpdate(req.params.id, result);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.put('/conversations/:id/position', commitBoardAction((req) => {
    activityService?.assertBoardSetupAllowed(req.params.id);
    return chessService.setPosition(req.params.id, req.body || {});
  }));

  router.post('/conversations/:id/reset', commitBoardAction((req) => {
    activityService?.assertBoardSetupAllowed(req.params.id);
    return chessService.reset(req.params.id, req.body || {});
  }));

  router.patch('/conversations/:id/board', commitBoardAction((req) =>
    chessService.setOrientation(req.params.id, req.body || {})));

  router.post('/conversations/:id/activities', (req, res, next) => {
    try {
      if (req.body?.type !== 'practice_game') {
        return res.status(400).json({ error: 'This activity requires a catalog item or validated proposal.' });
      }
      const activity = activityService.startPractice(req.params.id, req.body || {});
      return res.status(201).json({ activity, state: chessService.getState(req.params.id) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/conversations/:id/activities/:activityId/pause', (req, res, next) => {
    try {
      const activity = activityService.get(req.params.id);
      if (!activity || activity.id !== req.params.activityId) return res.status(404).json({ error: 'Activity not found.' });
      return res.json({ activity: activityService.pause(req.params.id) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/conversations/:id/activities/:activityId/resume', (req, res, next) => {
    try {
      const activity = activityService.get(req.params.id);
      if (!activity || activity.id !== req.params.activityId) return res.status(404).json({ error: 'Activity not found.' });
      return res.json({ activity: activityService.resume(req.params.id) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/conversations/:id/activities/:activityId/end', (req, res, next) => {
    try {
      const activity = activityService.get(req.params.id);
      if (!activity || activity.id !== req.params.activityId) return res.status(404).json({ error: 'Activity not found.' });
      return res.json({ activity: activityService.end(req.params.id) });
    } catch (error) {
      return next(error);
    }
  });

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
