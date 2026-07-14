# Vendored chess-library

- Upstream: https://github.com/Disservin/chess-library
- Pinned commit: `57159616358c2d4c09e0d4fb1562ca7f2d36a2fb`
- License: MIT; see `LICENSE` in this directory.

The vendored single header is intentionally unmodified. `offline_game.h` defines `CHESS_NO_EXCEPTIONS` before including it so invalid external input can be rejected without C++ exceptions.
