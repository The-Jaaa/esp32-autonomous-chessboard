# Physical LED Layout

The board contains 256 NeoPixels: four LEDs in a 2x2 block for each of the 64
chess squares. Web calibration numbers are 1-based (`1-256`), while
`Adafruit_NeoPixel` indices are 0-based (`0-255`).

## Square Sequence

Each physical square owns four consecutive pixels. The square sequence matches
the existing raw physical square map exactly:

| Physical row | Square traversal | 1-based LED range |
| --- | --- | --- |
| H | H8 to H1 | 1-32 |
| G | G1 to G8 | 33-64 |
| F | F8 to F1 | 65-96 |
| E | E1 to E8 | 97-128 |
| D | D8 to D1 | 129-160 |
| C | C1 to C8 | 161-192 |
| B | B8 to B1 | 193-224 |
| A | A1 to A8 | 225-256 |

For raw physical square index `s`, the four zero-based strip indices are
`s * 4` through `s * 4 + 3`. Existing whole-square lighting is therefore
correct.

## Within-Square Order

The order below lists the physical 2x2 positions visited by increasing pixel
index within every square on that letter row:

| Row | Increasing-index order | Offsets as TL, TR, BL, BR |
| --- | --- | --- |
| H | TR, BR, BL, TL | 3, 0, 2, 1 |
| G | BL, TL, TR, BR | 1, 2, 0, 3 |
| F | BR, TR, TL, BL | 2, 1, 3, 0 |
| E | BL, TL, TR, BR | 1, 2, 0, 3 |
| D | BR, TR, TL, BL | 2, 1, 3, 0 |
| C | TL, BL, BR, TR | 0, 3, 1, 2 |
| B | BR, TR, TL, BL | 2, 1, 3, 0 |
| A | BL, TL, TR, BR | 1, 2, 0, 3 |

`Offsets as TL, TR, BL, BR` means that, given `base = rawSquareIndex * 4`,
the four physical positions use `base + offset`. For example:

- H8: TL=3, TR=0, BL=2, BR=1 in zero-based strip indices, corresponding to
  calibration numbers TL=4, TR=1, BL=3, BR=2.
- C1 starts at strip index 160: TL=160, TR=163, BL=161, BR=162,
  corresponding to calibration numbers 161, 164, 162, and 163.
- A1 starts at strip index 224: TL=225, TR=226, BL=224, BR=227,
  corresponding to calibration numbers 226, 227, 225, and 228.

The C and H rows are intentionally different from the otherwise repeating
patterns. A 16x16 renderer must use this row-specific table rather than one
universal four-pixel orientation.

## 16x16 Coordinates

For future text and symbol rendering, define visual matrix row 0 as the top
edge of physical row A and visual matrix column 0 as the left edge of physical
column 1. For chess square `<letter><number>`:

- square matrix row = `(letter - 'A') * 2`;
- square matrix column = `(number - 1) * 2`;
- TL, TR, BL, and BR occupy `(row, col)`, `(row, col + 1)`,
  `(row + 1, col)`, and `(row + 1, col + 1)`;
- convert that local position to a strip index with the row-specific offsets
  above.

This mapping was physically measured one LED at a time and confirmed from the
annotated board photograph on 2026-07-17.
