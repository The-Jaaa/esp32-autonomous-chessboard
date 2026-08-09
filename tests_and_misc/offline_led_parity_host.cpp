#include "../offline_core/offline_led.h"

#include <algorithm>
#include <cstddef>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::Highlight;
using offline::HighlightRole;
using offline::LedColor;
using offline::LedFrame;
using offline::OfflineFeedbackInput;
using offline::OfflineFeedbackState;
using offline::OfflineLedRenderer;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::pair<std::size_t, std::size_t>> litMatrixPixels(
    const LedFrame& frame) {
  std::vector<std::pair<std::size_t, std::size_t>> result;
  for (std::size_t index = 0; index < frame.size(); ++index) {
    if (frame[index] == offline::led_colors::kOff) continue;
    const auto matrix = OfflineLedRenderer::stripIndexToMatrix(index);
    require(matrix.has_value(), "A lit strip pixel has no matrix coordinate.");
    result.push_back(*matrix);
  }
  return result;
}

std::vector<LedColor> colorsIn(const LedFrame& frame) {
  std::vector<LedColor> colors;
  for (const LedColor& color : frame) {
    if (color != offline::led_colors::kOff &&
        std::find(colors.begin(), colors.end(), color) == colors.end()) {
      colors.push_back(color);
    }
  }
  return colors;
}

bool squareHasColor(const LedFrame& frame, const std::string& square, LedColor color) {
  const int raw = offline::squareToRawIndex(square);
  require(raw >= 0, "Invalid LED test square.");
  for (std::size_t offset = 0; offset < 4; ++offset) {
    if (frame[static_cast<std::size_t>(raw) * 4 + offset] == color) return true;
  }
  return false;
}

void verifyMapping() {
  std::set<int> indices;
  for (std::size_t row = 0; row < OfflineLedRenderer::kHeight; ++row) {
    for (std::size_t column = 0; column < OfflineLedRenderer::kWidth; ++column) {
      const int index = OfflineLedRenderer::matrixToStripIndex(row, column);
      require(index >= 0 && index < 256, "LED mapping escaped the strip bounds.");
      require(indices.insert(index).second, "LED mapping is not bijective.");
      const auto inverse = OfflineLedRenderer::stripIndexToMatrix(
          static_cast<std::size_t>(index));
      require(inverse && inverse->first == row && inverse->second == column,
              "LED mapping inverse is not exact.");
    }
  }
  require(indices.size() == 256, "LED mapping does not cover all pixels.");
  require(OfflineLedRenderer::matrixToStripIndex(14, 14) == 3 &&
              OfflineLedRenderer::matrixToStripIndex(14, 15) == 0 &&
              OfflineLedRenderer::matrixToStripIndex(15, 14) == 2 &&
              OfflineLedRenderer::matrixToStripIndex(15, 15) == 1,
          "The H-row orientation changed.");
  require(OfflineLedRenderer::matrixToStripIndex(4, 0) == 160 &&
              OfflineLedRenderer::matrixToStripIndex(4, 1) == 163 &&
              OfflineLedRenderer::matrixToStripIndex(5, 0) == 161 &&
              OfflineLedRenderer::matrixToStripIndex(5, 1) == 162,
          "The C-row orientation changed.");
  require(OfflineLedRenderer::matrixToStripIndex(16, 0) == -1 &&
              !OfflineLedRenderer::stripIndexToMatrix(256),
          "Out-of-bounds coordinates were accepted.");
}

void verifyTextOrientation() {
  LedFrame compact{};
  require(OfflineLedRenderer::drawCompactText(
              compact, "A", offline::led_colors::kAmber),
          "Compact A did not render.");
  const auto pixels = litMatrixPixels(compact);
  require(!pixels.empty(), "Compact text rendered no pixels.");
  const auto rowBounds = std::minmax_element(
      pixels.begin(), pixels.end(),
      [](const auto& left, const auto& right) { return left.first < right.first; });
  const auto columnBounds = std::minmax_element(
      pixels.begin(), pixels.end(),
      [](const auto& left, const auto& right) { return left.second < right.second; });
  require(rowBounds.first->first == 6 && rowBounds.second->first == 8 &&
              columnBounds.first->second == 5 && columnBounds.second->second == 9,
          "Compact text is not in the fixed sideways orientation.");

  LedFrame promotion{};
  require(OfflineLedRenderer::drawPromotionLetter(
              promotion, 'Q', offline::led_colors::kPurple),
          "Promotion Q did not render.");
  const auto promotionPixels = litMatrixPixels(promotion);
  const auto promotionRows = std::minmax_element(
      promotionPixels.begin(), promotionPixels.end(),
      [](const auto& left, const auto& right) { return left.first < right.first; });
  const auto promotionColumns = std::minmax_element(
      promotionPixels.begin(), promotionPixels.end(),
      [](const auto& left, const auto& right) { return left.second < right.second; });
  require(promotionRows.first->first == 3 && promotionRows.second->first == 11 &&
              promotionColumns.first->second == 4 && promotionColumns.second->second == 10,
          "Promotion text is not in the fixed sideways orientation.");
}

void verifyPaletteAndLayering() {
  OfflineFeedbackInput setup;
  setup.state = OfflineFeedbackState::Setup;
  setup.detectedSquares = {"a2"};
  setup.difference.missing = {"a7"};
  setup.difference.extra = {"a3"};
  const LedFrame setupFrame = OfflineLedRenderer::render(setup);
  require(squareHasColor(setupFrame, "a2", offline::led_colors::kCorrect),
          "Detected squares did not use the online correct color.");
  require(squareHasColor(setupFrame, "a7", offline::led_colors::kRed) &&
              squareHasColor(setupFrame, "a3", offline::led_colors::kYellow),
          "Setup missing/extra colors do not match the online palette.");

  OfflineFeedbackInput interaction;
  interaction.state = OfflineFeedbackState::HumanInteraction;
  interaction.highlights = {
      {"a1", offline::squareToRawIndex("a1"), HighlightRole::Source},
      {"a2", offline::squareToRawIndex("a2"), HighlightRole::QuietTarget},
      {"a3", offline::squareToRawIndex("a3"), HighlightRole::CaptureTarget},
      {"a4", offline::squareToRawIndex("a4"), HighlightRole::SpecialTarget}};
  const LedFrame interactionFrame = OfflineLedRenderer::render(interaction);
  require(squareHasColor(interactionFrame, "a1", offline::led_colors::kBlue) &&
              squareHasColor(interactionFrame, "a2", offline::led_colors::kGreen) &&
              squareHasColor(interactionFrame, "a3", offline::led_colors::kRed) &&
              squareHasColor(interactionFrame, "a4", offline::led_colors::kPurple),
          "Move-role colors do not match the online palette.");

  OfflineFeedbackInput robot;
  robot.state = OfflineFeedbackState::RobotExecuting;
  robot.robotPathSquares = {"a5"};
  robot.highlights = {{"a6", offline::squareToRawIndex("a6"), HighlightRole::Source}};
  const LedFrame robotFrame = OfflineLedRenderer::render(robot);
  require(squareHasColor(robotFrame, "a5", offline::led_colors::kGreen) &&
              squareHasColor(robotFrame, "a6", offline::led_colors::kBlue),
          "Robot path/source layering changed.");

  OfflineFeedbackInput check;
  check.state = OfflineFeedbackState::Check;
  check.checkedKingSquare = "e8";
  require(squareHasColor(OfflineLedRenderer::render(check), "e8",
                         offline::led_colors::kCheck),
          "Offline check feedback does not use the online check color.");

  const LedFrame deterministicA = OfflineLedRenderer::render(setup);
  const LedFrame deterministicB = OfflineLedRenderer::render(setup);
  require(deterministicA == deterministicB, "Identical LED inputs are not deterministic.");
  require(colorsIn(deterministicA).size() == 4,
          "Setup frame did not retain text/present/missing-extra layering.");
}

}  // namespace

int main() {
  try {
    verifyMapping();
    verifyTextOrientation();
    verifyPaletteAndLayering();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline LED parity regression failed: " << error.what() << std::endl;
    return 1;
  }
}
