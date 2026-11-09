#pragma once

// Sensor debounce happens in scanSensors before this guard sees occupancy.
struct AutonomousLiftGuard {
  bool restoring = false;
  bool takeover = false;
  bool interference = false;
  bool protectedSquares[64] = {};
  bool expected[64] = {};
  void observe(const bool* occupied) {
    if (!restoring) return;
    for (int i = 0; i < 64; i++) {
      if (protectedSquares[i]) continue;
      if (expected[i] && !occupied[i]) takeover = true;
      if (!expected[i] && occupied[i]) interference = true;
    }
  }
  bool reconcile(const bool* actual, const bool* corrected, bool magnetOff, bool positioningValid) {
    if(!magnetOff || !positioningValid) return false;
    for(int i=0;i<64;i++) if(actual[i]!=corrected[i]) return false;
    for(int i=0;i<64;i++) expected[i]=corrected[i];
    interference=false;
    return true; // takeover is intentionally unchanged
  }
  bool permitsTransfer() const { return !takeover && !interference; }
};
