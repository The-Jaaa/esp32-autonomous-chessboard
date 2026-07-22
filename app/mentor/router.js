const express = require('express');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createMentorRouter({
  store,
  service,
  chessService,
  activityService,
  liveService,
  speakerService,
  physicalObserver,
  emitBoardUpdate = () => {}
}) {
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

  router.get('/audio/devices', (req, res) => {
    res.json({ devices: speakerService?.listDevices?.() || [] });
  });

  router.get('/physical-board', (req, res) => {
    res.json(physicalObserver.availability());
  });

  router.post('/conversations', (req, res) => {
    const conversation = store.createConversation(req.body || {});
    res.status(201).json({
      conversation: {
        ...conversation,
        messages: [],
        chess: chessService.getState(conversation.id),
        physicalBoard: physicalObserver.detail(conversation.id),
        activity: activityService?.get(conversation.id) || null,
        progress: activityService?.getProgressSummary() || null
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
        physicalBoard: physicalObserver.detail(conversation.id),
        activity: activityService?.get(conversation.id) || null,
        progress: activityService?.getProgressSummary() || null
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
      if (physicalObserver.isAttached(req.params.id)) {
        const error = new Error('The attached physical board is read-only from the mentor workspace.');
        error.code = 'physical_board_read_only';
        error.statusCode = 409;
        throw error;
      }
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
    if (physicalObserver.isAttached(req.params.id)) {
      const error = new Error('Detach the physical board before loading a virtual position.');
      error.code = 'physical_board_read_only';
      error.statusCode = 409;
      throw error;
    }
    activityService?.assertBoardSetupAllowed(req.params.id);
    return chessService.setPosition(req.params.id, req.body || {});
  }));

  router.post('/conversations/:id/reset', commitBoardAction((req) => {
    if (physicalObserver.isAttached(req.params.id)) {
      const error = new Error('Detach the physical board before resetting the virtual position.');
      error.code = 'physical_board_read_only';
      error.statusCode = 409;
      throw error;
    }
    activityService?.assertBoardSetupAllowed(req.params.id);
    return chessService.reset(req.params.id, req.body || {});
  }));

  router.patch('/conversations/:id/board', commitBoardAction((req) => {
    if (physicalObserver.isAttached(req.params.id)) {
      const error = new Error('Use the physical-board view endpoint while the physical board is attached.');
      error.code = 'physical_board_read_only';
      error.statusCode = 409;
      throw error;
    }
    return chessService.setOrientation(req.params.id, req.body || {});
  }));

  router.post('/conversations/:id/physical-board', (req, res, next) => {
    try {
      return res.json({ physicalBoard: physicalObserver.attach(req.params.id, req.body || {}) });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/conversations/:id/physical-board', (req, res, next) => {
    try {
      const result = physicalObserver.setOrientation(req.params.id, req.body || {});
      return res.json({ physicalBoard: physicalObserver.detail(req.params.id), state: result.state });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/conversations/:id/physical-board', (req, res, next) => {
    try {
      return res.json({ physicalBoard: physicalObserver.detach(req.params.id) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/catalog', (req, res) => {
    res.json({ catalog: activityService.catalog(req.query.type || null) });
  });

  router.get('/profile', (req, res) => {
    res.json(activityService.getProgressSummary());
  });

  router.patch('/profile', (req, res, next) => {
    try {
      return res.json(activityService.updateProfile(req.body || {}));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/recommendations', (req, res) => {
    const summary = activityService.getProgressSummary();
    res.json({ recommendations: summary.recommendations, profile: summary.profile, topics: summary.topics });
  });

  router.post('/conversations/:id/activities', asyncRoute(async (req, res) => {
      if (physicalObserver.isAttached(req.params.id)) {
        const error = new Error('Physical-board activities are not available yet.');
        error.code = 'physical_board_read_only';
        error.statusCode = 409;
        throw error;
      }
      const activity = await activityService.startActivity(req.params.id, req.body || {});
      return res.status(201).json({ activity, state: chessService.getState(req.params.id) });
  }));

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

  router.post('/conversations/:id/activities/:activityId/hint', (req, res, next) => {
    try {
      const activity = activityService.get(req.params.id);
      if (!activity || activity.id !== req.params.activityId) return res.status(404).json({ error: 'Activity not found.' });
      return res.json(activityService.requestHint(req.params.id));
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
      state: error.state,
      boundConversationId: error.boundConversationId
    });
  });

  return router;
}

module.exports = { createMentorRouter };
