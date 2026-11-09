#include "../esp32_firmware/autonomous_guard.h"
#include <cassert>
#include <iostream>
int main() {
  {
    AutonomousLiftGuard guard;
    bool actual[64]={}, corrected[64]={};
    guard.takeover=true;guard.interference=true;corrected[4]=true;
    assert(!guard.reconcile(actual,corrected,true,true));
    actual[4]=true;
    assert(!guard.reconcile(actual,corrected,false,true));
    assert(!guard.reconcile(actual,corrected,true,false));
    assert(guard.reconcile(actual,corrected,true,true));
    assert(guard.expected[4]);assert(!guard.interference);assert(guard.takeover);
  }

  AutonomousLiftGuard guard;
  bool board[64] = {};
  guard.expected[0] = board[0] = true;
  guard.expected[1] = board[1] = true;
  board[1] = false;
  guard.observe(board);
  assert(!guard.takeover); // Outside restoration, lifts are not takeover gestures.
  guard.restoring = true;
  guard.protectedSquares[1] = true;
  guard.observe(board);
  assert(!guard.takeover); // Current transaction pickup is expected.
  board[2] = true;
  guard.protectedSquares[2] = true;
  guard.observe(board);
  assert(!guard.interference); // Drop/staging squares are also reserved.
  board[0] = false;
  guard.observe(board);
  assert(guard.takeover && !guard.permitsTransfer());
  board[0] = true;
  guard.observe(board);
  assert(guard.takeover); // Replacing the lifted piece must not cancel handover.
  guard.takeover = false;
  board[7] = true;
  guard.observe(board);
  assert(guard.interference && !guard.permitsTransfer() && !guard.takeover);
  std::cout << "Firmware guard: protected pickup/drop, unrelated lift latch, placement interference, and next-transfer inhibition passed.\n";
}
