#pragma once

#include "offline_physical.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace offline {

struct LedColor {
  std::uint8_t red = 0;
  std::uint8_t green = 0;
  std::uint8_t blue = 0;

  [[nodiscard]] bool operator==(const LedColor& other) const {
    return red == other.red && green == other.green && blue == other.blue;
  }
  [[nodiscard]] bool operator!=(const LedColor& other) const {
    return !(*this == other);
  }
};

using LedFrame = std::array<LedColor, 256>;

namespace led_colors {
inline constexpr LedColor kOff{0, 0, 0};
inline constexpr LedColor kBlue{0, 70, 255};
inline constexpr LedColor kGreen{0, 220, 60};
inline constexpr LedColor kRed{255, 20, 10};
inline constexpr LedColor kPurple{180, 80, 255};
inline constexpr LedColor kYellow{255, 180, 0};
inline constexpr LedColor kAmber{255, 100, 0};
inline constexpr LedColor kWhite{200, 200, 200};
inline constexpr LedColor kCyan{0, 190, 220};
}  // namespace led_colors

enum class OfflineFeedbackState {
  Clear,
  Wait,
  Setup,
  ClearGraveyards,
  SideSelection,
  SideSelected,
  HumanReady,
  HumanInteraction,
  EngineThinking,
  RobotExecuting,
  SyncWarning,
  Success,
  Check,
  Checkmate,
  Draw,
  PromotionPrompt,
  PromotionChoice,
  Error
};

struct OfflineFeedbackInput {
  OfflineFeedbackState state = OfflineFeedbackState::Clear;
  std::vector<Highlight> highlights;
  OccupancyDiff difference;
  std::vector<std::string> detectedSquares;
  std::vector<std::string> robotPathSquares;
  std::optional<HumanColor> selectedColor;
  std::optional<std::string> checkedKingSquare;
  std::optional<std::string> winningKingSquare;
  std::optional<std::string> losingKingSquare;
  std::optional<std::string> promotionSquare;
  char promotionChoice = 0;
  bool animationOn = true;
};

class OfflineLedRenderer {
 public:
  static constexpr std::size_t kWidth = 16;
  static constexpr std::size_t kHeight = 16;
  static constexpr std::uint8_t kBrightness = 40;

  [[nodiscard]] static int matrixToStripIndex(
      std::size_t row, std::size_t column);
  [[nodiscard]] static std::optional<std::pair<std::size_t, std::size_t>>
  stripIndexToMatrix(std::size_t stripIndex);

  static void clear(LedFrame& frame);
  static bool setMatrixPixel(
      LedFrame& frame, std::size_t row, std::size_t column, LedColor color);
  static bool setSquareColor(
      LedFrame& frame, std::string_view square, LedColor color);
  static bool drawCompactText(
      LedFrame& frame, std::string_view text, LedColor color);
  static bool drawPromotionLetter(
      LedFrame& frame, char piece, LedColor color);

  [[nodiscard]] static LedFrame render(const OfflineFeedbackInput& input);
};

const char* offlineFeedbackStateName(OfflineFeedbackState state);

}  // namespace offline
