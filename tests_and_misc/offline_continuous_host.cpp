#include "../offline_core/offline_continuous.h"
#include "../offline_core/offline_game.h"
#include "../offline_core/offline_led.h"

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

using offline::LedFrame;
using offline::Occupancy;
using offline::OfflineContinuousEvent;
using offline::OfflineContinuousSessionController;
using offline::OfflineContinuousState;
using offline::OfflineFeedbackInput;
using offline::OfflineFeedbackState;
using offline::OfflineLedRenderer;

constexpr const char* kStartFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

void verifyResetLifecycle() {
  const Occupancy setup = offline::occupancyFromFen(kStartFen);
  Occupancy terminal = offline::occupancyFromFen(
      "5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2");
  Occupancy oneKing = terminal;
  setSquare(oneKing, "f1", false);
  Occupancy bothKings = oneKing;
  setSquare(bothKings, "g8", false);

  OfflineContinuousSessionController session(setup);
  auto update = session.beginGame(10);
  require(update.event == OfflineContinuousEvent::GameStarted &&
              update.generation == 1 &&
              update.state == OfflineContinuousState::Playing,
          "The first continuous game did not start with generation one.");
  update = session.beginGame(11);
  require(update.event == OfflineContinuousEvent::None &&
              update.generation == 1 &&
              update.state == OfflineContinuousState::Playing,
          "A duplicate game start changed the active session generation.");
  update = session.enterGameOver(100, terminal, "f1", "g8");
  require(update.event == OfflineContinuousEvent::GameEnded,
          "The terminal board did not arm reset selection.");
  update = session.enterGameOver(101, terminal, "f1", "g8");
  require(update.event == OfflineContinuousEvent::None &&
              update.state == OfflineContinuousState::GameOver,
          "A duplicate game-over callback changed terminal reset state.");
  require(session.processSnapshot(200, oneKing).event == OfflineContinuousEvent::None,
          "A single lifted king must not start the reset hold.");
  update = session.processSnapshot(300, bothKings);
  require(update.event == OfflineContinuousEvent::ResetHoldStarted,
          "Both lifted kings did not start the reset hold.");
  require(session.processSnapshot(2299, bothKings).state ==
              OfflineContinuousState::HoldingReset,
          "The reset latched before 2000 ms.");
  update = session.processSnapshot(2300, bothKings);
  require(update.event == OfflineContinuousEvent::ResetLatched &&
              update.state == OfflineContinuousState::ClearGraveyards,
          "The reset did not latch at 2000 ms.");

  update = session.processSnapshot(2400, setup);
  require(update.event == OfflineContinuousEvent::SetupStabilizing,
          "Exact standard setup did not begin stabilization.");
  require(session.processSnapshot(2899, setup).state ==
              OfflineContinuousState::SetupStabilizing,
          "The setup confirmed before 500 ms.");
  update = session.processSnapshot(2900, setup);
  require(update.event == OfflineContinuousEvent::SetupReady &&
              update.state == OfflineContinuousState::ReadyForSide,
          "The standard setup did not confirm at 500 ms.");
  update = session.beginGame(3000);
  require(update.generation == 2 &&
              session.validateGeneration(1).event ==
                  OfflineContinuousEvent::StaleGenerationRejected &&
              session.validateGeneration(2).event == OfflineContinuousEvent::None,
          "A new game did not reject stale generation work.");
}

void verifyCancellationAndRecovery() {
  const Occupancy setup = offline::occupancyFromFen(kStartFen);
  const Occupancy terminal = offline::occupancyFromFen(
      "5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2");
  Occupancy bothKings = terminal;
  setSquare(bothKings, "f1", false);
  setSquare(bothKings, "g8", false);

  OfflineContinuousSessionController session(setup);
  session.beginGame();
  session.enterGameOver(0, terminal, "f1", "g8");
  session.processSnapshot(1, bothKings);
  auto update = session.processSnapshot(1000, terminal);
  require(update.event == OfflineContinuousEvent::ResetCancelled &&
              update.state == OfflineContinuousState::GameOver,
          "Early king restoration did not cancel the reset gesture.");

  Occupancy disturbed = terminal;
  setSquare(disturbed, "a3", false);
  update = session.processSnapshot(1100, disturbed);
  require(update.state == OfflineContinuousState::SyncWarning &&
              !update.difference.empty(),
          "An unrelated terminal disturbance did not enter SyncWarning.");
  update = session.processSnapshot(1200, terminal);
  require(update.event == OfflineContinuousEvent::Recovered &&
              update.state == OfflineContinuousState::GameOver,
          "Exact terminal restoration did not recover reset selection.");
}

void verifyWraparoundAndSetupRelift() {
  const Occupancy setup = offline::occupancyFromFen(kStartFen);
  const Occupancy terminal = offline::occupancyFromFen(
      "5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2");
  Occupancy bothKings = terminal;
  setSquare(bothKings, "f1", false);
  setSquare(bothKings, "g8", false);
  const std::uint32_t wrap = 0xFFFFFC00U;

  OfflineContinuousSessionController session(setup);
  session.beginGame(wrap);
  session.enterGameOver(wrap, terminal, "f1", "g8");
  session.processSnapshot(wrap + 100U, bothKings);
  require(session.processSnapshot(wrap + 2099U, bothKings).state ==
              OfflineContinuousState::HoldingReset,
          "Reset hold failed before millis wraparound.");
  require(session.processSnapshot(wrap + 2100U, bothKings).event ==
              OfflineContinuousEvent::ResetLatched,
          "Reset hold failed across millis wraparound.");
  session.processSnapshot(wrap + 2200U, setup);
  Occupancy changed = setup;
  setSquare(changed, "a2", false);
  require(session.processSnapshot(wrap + 2400U, changed).state ==
              OfflineContinuousState::ClearGraveyards,
          "A setup re-lift did not restart setup confirmation.");
}

void verifyClearFrameAndInvalidGameOver() {
  OfflineFeedbackInput input;
  input.state = OfflineFeedbackState::ClearGraveyards;
  input.detectedSquares = {"a2"};
  input.difference.missing = {"a7"};
  input.difference.extra = {"a3"};
  const LedFrame actual = OfflineLedRenderer::render(input);
  LedFrame expected{};
  OfflineLedRenderer::drawCompactText(expected, "CLR", offline::led_colors::kAmber);
  OfflineLedRenderer::setSquareColor(expected, "a2", offline::led_colors::kCorrect);
  OfflineLedRenderer::setSquareColor(expected, "a7", offline::led_colors::kRed);
  OfflineLedRenderer::setSquareColor(expected, "a3", offline::led_colors::kYellow);
  require(actual == expected, "CLR setup feedback did not show exact occupancy.");

  const Occupancy setup = offline::occupancyFromFen(kStartFen);
  OfflineContinuousSessionController session(setup);
  session.beginGame();
  const auto invalid = session.enterGameOver(0, setup, "e1", "e1");
  require(invalid.state == OfflineContinuousState::Error,
          "Invalid king metadata was accepted for game-over reset.");
}

}  // namespace

int main() {
  try {
    verifyResetLifecycle();
    verifyCancellationAndRecovery();
    verifyWraparoundAndSetupRelift();
    verifyClearFrameAndInvalidGameOver();
    std::cout << "offline continuous regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline continuous regression failed: " << error.what() << '\n';
    return 1;
  }
}
