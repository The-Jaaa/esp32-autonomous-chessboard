process.env.PHYSICAL_LOG_DISABLE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore } = require('../mentor/store');
const { MentorActivityService } = require('../mentor/activity-service');
const { getCatalogItem, listCatalog } = require('../mentor/curriculum');
const {
  physicalBoardTest: { physicalSession, occupancyFromGame },
  physicalPlanner: {
    DEFAULT_GRAVEYARD_SLOTS,
    buildStrictOpeningRobotMoveCommand,
    normalizeGraveyardSlots,
    moveToUci
  }
} = require('../server');

function setPlanningPosition(game) {
  physicalSession.active = true;
  physicalSession.phase = 'ready';
  physicalSession.game = new Chess(game.fen());
  physicalSession.occupancy = occupancyFromGame(physicalSession.game);
  physicalSession.graveyardSlots = normalizeGraveyardSlots(DEFAULT_GRAVEYARD_SLOTS);
  physicalSession.robotGraveyardOccupied = [];
  physicalSession.robotGraveyardPending = [];
  physicalSession.nextGraveyardSlot = 0;
  physicalSession.lastSnapshotAt = Date.now();
}

function verifyCatalogAndPlans() {
  const openings = listCatalog().filter((item) => item.type === 'opening_drill');
  assert.strictEqual(openings.length, 18);
  const temporaryClearances = new Set();

  for (const summary of openings) {
    const item = getCatalogItem(summary.id);
    assert.strictEqual(summary.supportsPhysical, true, `${item.id} should support the physical board`);
    assert.strictEqual(item.line.length, 10, `${item.id} should contain ten reviewed plies`);
    const game = new Chess(item.initialFen);
    for (let index = 0; index < item.line.length; index += 1) {
      const uci = item.line[index];
      const move = game.moves({ verbose: true })
        .find((candidate) => moveToUci(candidate) === uci);
      assert(move, `${item.id} contains illegal move ${uci} at ply ${index + 1}`);
      if (index % 2 === 1) {
        setPlanningPosition(game);
        const command = buildStrictOpeningRobotMoveCommand(move);
        assert.strictEqual(command.move, uci, `${item.id} must not substitute ${uci}`);
        assert(command.plan.length > 0, `${item.id} ${uci} should produce motion phases`);
        if (command.temporaryClearance && uci === 'b8c6') {
          temporaryClearances.add(uci);
          assert.deepStrictEqual(command.temporaryClearance?.phases, [
            'temporary-clearance-stage',
            'quiet-transfer',
            'temporary-clearance-restore'
          ]);
          assert.strictEqual(command.temporaryClearance.pawnFrom, 'a7');
          assert.strictEqual(command.temporaryClearance.pawnTemp, 'a5');
        }
        if (command.temporaryClearance && uci === 'g8f6') {
          temporaryClearances.add(uci);
          assert.deepStrictEqual(command.temporaryClearance?.phases, [
            'temporary-clearance-stage',
            'quiet-transfer',
            'temporary-clearance-restore'
          ]);
          assert.strictEqual(command.temporaryClearance.pawnFrom, 'h7');
          assert.strictEqual(command.temporaryClearance.pawnTemp, 'h5');
        }
      }
      game.move({ from: move.from, to: move.to, promotion: move.promotion });
    }
  }
  assert.deepStrictEqual([...temporaryClearances].sort(), ['b8c6', 'g8f6']);
}

function createActivityHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-opening-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const synchronized = [];
  const resolved = [];
  const announced = [];
  let service;
  const coordinator = {
    isAttached: () => true,
    requireOpeningStartState: (_conversationId, expectedRevision) => {
      assert.strictEqual(expectedRevision, 12);
      return {
        revision: 12,
        physical: { serverInstanceId: 'server-test', sessionGeneration: 4 }
      };
    },
    syncPhysicalActivity: (activity) => synchronized.push(service.getPhysicalPolicy(activity.conversationId)),
    announcePhysicalOpening: (activity) => announced.push(activity.id),
    retryPhysicalOpening: () => ({ success: true, move: 'e7e5' }),
    resolvePhysicalOpening: (_conversationId, action) => resolved.push(action),
    resumeNormalPlay: () => ({ success: true, action: 'resume' })
  };
  service = new MentorActivityService({
    store,
    chessService: {},
    analysisService: {},
    emit: () => {},
    emitGlobal: () => {}
  });
  service.setPhysicalCoordinator(coordinator);
  return { tempDir, store, service, synchronized, resolved, announced };
}

function commitLine(service, conversationId, item) {
  const game = new Chess(item.initialFen);
  for (let index = 0; index < item.line.length; index += 1) {
    const uci = item.line[index];
    const move = game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4]
    });
    assert(move, `test line move ${uci} should be legal`);
    service.physicalMoveCommitted(conversationId, {
      side: index % 2 === 0 ? 'human' : 'engine',
      uci,
      san: move.san,
      revision: 13 + index,
      moveId: `physical-move-${index + 1}`,
      gameStatus: { checkmate: game.isCheckmate(), draw: game.isDraw() }
    });
  }
}

function verifyActivityTransaction() {
  const harness = createActivityHarness();
  try {
    const conversation = harness.store.createConversation();
    const item = getCatalogItem('queens-gambit');
    let activity = harness.service.startPhysicalOpening(conversation.id, {
      type: 'opening_drill',
      sourceId: item.id,
      learnerColor: 'white',
      expectedRevision: 12
    });
    assert.strictEqual(activity.phase, 'learner_turn');
    assert.strictEqual(activity.config.boardSource, 'physical');
    assert.deepStrictEqual(harness.announced, [activity.id]);
    assert.strictEqual(harness.service.getPhysicalPolicy(conversation.id).expectedUci, 'd2d4');
    assert.throws(
      () => harness.service.validatePhysicalLearnerMove(conversation.id, 'e2e4'),
      (error) => error.code === 'activity_incorrect_move'
    );
    assert.strictEqual(harness.service.get(conversation.id).attempts, 1);

    commitLine(harness.service, conversation.id, item);
    activity = harness.service.get(conversation.id);
    assert.strictEqual(activity.status, 'paused');
    assert.strictEqual(activity.state.pauseReason, 'line_complete');
    assert.strictEqual(activity.stepIndex, 10);

    harness.service.resolvePhysicalOpening(conversation.id, 'repeat');
    activity = harness.service.get(conversation.id);
    assert.strictEqual(activity.state.pauseReason, 'repeat_restore');
    harness.service.completePhysicalRepeat(conversation.id, 40);
    activity = harness.service.get(conversation.id);
    assert.strictEqual(activity.phase, 'learner_turn');
    assert.strictEqual(activity.stepIndex, 0);
    assert.strictEqual(activity.state.iteration, 2);

    harness.service.markPhysicalRouteBlocked(conversation.id, { move: 'd7d5', error: 'blocked' });
    activity = harness.service.get(conversation.id);
    assert.strictEqual(activity.state.pauseReason, 'route_blocked');
    harness.service.resolvePhysicalOpening(conversation.id, 'retry');
    activity = harness.service.get(conversation.id);
    assert.strictEqual(activity.status, 'active');
    assert.strictEqual(activity.phase, 'mentor_turn');

    const second = harness.store.createConversation();
    const secondActivity = harness.service.startPhysicalOpening(second.id, {
      type: 'opening_drill', sourceId: 'italian-game', learnerColor: 'white', expectedRevision: 12
    });
    assert(secondActivity);
    assert.throws(
      () => harness.service.startPhysicalOpening(harness.store.createConversation().id, {
        type: 'puzzle', sourceId: 'royal-fork', learnerColor: 'white', expectedRevision: 12
      }),
      (error) => error.code === 'physical_activity_unsupported'
    );
  } finally {
    harness.store.close();
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

verifyCatalogAndPlans();
verifyActivityTransaction();
console.log('Mentor physical opening drill regressions passed.');
