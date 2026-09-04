# The VersaCAD `.2D` drawing format

There is no published specification for this format. Everything below was
reverse engineered from the eleven sample drawings in `samples/`, which cover
VersaCAD 5.2, 5.4, 6.0 and 7.0 and between them contain ~23,400 drawable
objects.
Confidence is noted per field: **solid** means it is exercised by every sample
and validated by rendering or by a round trip; **inferred** means the reading is
consistent with the data but not independently confirmed.

All values are **little-endian**. Doubles are IEEE-754 binary64 and are *not*
aligned to 8-byte boundaries — the layout is packed, so read them at the byte
offsets given.

---

## 1. File layout

A file is a flat array of **128-byte records**, padded with zero records to a
multiple of 512 bytes. There is no compression and no per-record checksum.

Byte `0x01` of a record is its **tag**:

| Tag | Meaning |
|-----|---------|
| `0x08`,`0x10`,`0x18`,`0x20`,`0x28`,`0x30`,`0x38` | the seven header records, in that fixed order (records 0–6) |
| `0x48`, `0x50` | saved views / plot setups (see §6) |
| `0x64` | a drawing entity (§3) |
| `0x58` | a symbol table entry (§4) |
| `0x66` | an entity that is *also* the first record of a symbol body (§4) |
| `0x00` | trailing zero padding |

Records are **not** self-describing about length. A text entity whose string is
too long to fit inline is followed by one continuation record whose bytes are
raw string data — the tag byte of such a record is just a character. The only
reliable way to walk the file is to use the section counts in the header and the
per-entity "consumed records" rule in §3.3.

### Sections

Record 0 gives the section table:

| Offset | Type | Meaning | Confidence |
|--------|------|---------|-----------|
| `0x00` | u8×2 | `00 08` signature | solid |
| `0x02` | u16 | version × 10: 52 = 5.2, 54 = 5.4, 60 = 6.0, 70 = 7.0 | solid |
| `0x04` | u16 | record index where the entity section starts | solid |
| `0x06` | u16 | record count of entity section **part 1** (the drawing) | solid |
| `0x08` | u16 | number of symbol-table records | solid |
| `0x0A` | u16 | record count of entity section **part 2** (symbol bodies) | solid |
| `0x14` | char[10] | `001VCADATT`, present when the drawing uses attributes | inferred |

Laying those end to end:

```
[0 .. 7)                                     header records
[7 .. entStart)                              saved views / plot setups
[entStart .. entStart+n1)                    drawing entities
[.. + nSym)                                  symbol table
[.. + n2)                                    symbol definition bodies
[.. end)                                     zero padding to a 512-byte multiple
```

This is exact for all eleven samples: the computed end always lands precisely on
the start of the zero padding.

### Header record 1 (tag `0x10`) — drawing extents

| Offset | Type | Meaning |
|--------|------|---------|
| `0x02` | f64 | min X |
| `0x0A` | f64 | max X |
| `0x12` | f64 | min Y |
| `0x1A` | f64 | max Y |

These are VersaCAD's stored extents. They are usually a little looser than the
true bounding box of the geometry, so a viewer is better off computing its own.

Header records 2–6 hold editor state: grid and snap settings, default text
height and width, the current part name, dimensioning defaults, and what looks
like a per-level visibility bitmap in record 3. None of it is needed to render a
drawing, and it is not decoded here.

---

## 2. Entity record shell

Every entity record (tag `0x64`, or `0x66` for the first record of a symbol
body) shares this frame:

| Offset | Type | Meaning | Confidence |
|--------|------|---------|-----------|
| `0x00` | u8 | flags (bit 3 and bit 7 are common; meaning unknown) | unknown |
| `0x01` | u8 | `0x64` tag | solid |
| `0x02` | u8 | level / group number, 0–30 observed | inferred |
| `0x05` | u8 | **pen** number, 1–7 | solid |
| `0x07` | u8 | **line type** number, 1–8 | solid |
| `0x1C` | f64 | X — start point, centre, insertion point, or text origin | solid |
| `0x24` | f64 | Y | solid |
| `0x3C` | f64 | rotation in radians (arcs, text, symbol inserts) | solid |
| `0x44` | char[7] | part / layer name, NUL-padded (`new` is the default) | solid |
| `0x4E` | u8 | subtype — **low nibble is the entity type** | solid |
| `0x73` | u8 | flag byte; bit `0x40` is the arc sweep direction (§3.2) | solid |
| `0x79` | u8 | flag byte; bit `0x80` is the dimension axis (§3.4) | solid |

The high nibble of `0x4E` varies (0–11) and is not needed to draw; it tracks
with drawing structure rather than appearance.

Pen and line type were confirmed by colour-coding a drawing by each byte: pen
separates sheet border / geometry / annotation onto different plotter pens, and
line type 4 traces exactly the axis centrelines of the rollers in `D05724F1.2D`.

---

## 3. Entity types (low nibble of `0x4E`)

### 3.1 Type 1 — line

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | ΔX |
| `0x58` | f64 | ΔY |

The end point is `(x + Δx, y + Δy)`. Lines are the most common entity by far.

### 3.2 Type 3 — arc / elliptical arc

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | radius along the local X axis |
| `0x58` | f64 | radius along the local Y axis |
| `0x60` | f64 | start angle, radians |
| `0x68` | f64 | end angle, radians |
| `0x3C` | f64 | rotation of the ellipse's major axis, radians |
| `0x73` | bit `0x40` | **sweep direction**: clear = counter-clockwise, set = clockwise |

`(0x1C, 0x24)` is the **centre**. Start == end means a full ellipse.

Two angles bound *two* arcs, and the direction bit says which one is meant, so
it cannot be ignored — get it wrong and you draw the complementary arc. Three
things confirm the reading:

* The bit is **never set on a line record** anywhere in the corpus, and on arcs
  byte `0x73` only ever holds 0, `0x40`, `0x80` or `0xC0` — it is a clean flag
  field, and `0x40` is arc-specific.
* Honouring it turns the distribution of sweep sizes from near-uniform
  (30 % / 27 % / 28 % / 16 % across the four quadrant bands — the signature of
  choosing at random) into **64 % at or below 90° and 91 % at or below 180°**,
  which is what fillets, rounds and corner radii actually look like.
* The human figures used for scale in `D6100.2D` only come out right with it:
  their hands, sleeves and shoulders are drawn from short arcs that render as
  near-complete loops without it.

Angles are parametric (the ellipse is traced as `C + U·cos t + V·sin t`); for
circles the two readings coincide, and no sample distinguishes them for
ellipses. Radii are always positive in every sample.

Bit `0x80` of the same byte is set on 38 arcs and 36 lines; its meaning is
unknown and ignoring it costs nothing visible.

### 3.3 Type 4 — text

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 (5.2, 5.4) / f32 (6.0, 7.0) | character **advance** (width per character) |
| `0x58` | f64 (5.2, 5.4) / f32 (6.0, 7.0) | character **height** (cap height) |
| `0x3C` | f64 | rotation, radians |
| `0x60` | u8 | font number (4 and 5 observed) |
| `0x61` | u8 | string length, with bit `0x80` as a flag — see below |
| `0x62` | char[30] | the string, when it fits inline |

The width-before-height order is easy to get backwards, so it is worth the
evidence. Three independent checks all point the same way:

* **Table rows share a height, not a width.** The five column headers of the
  tolerance table in `D05724F1.2D` sit on one row and all carry `0x58` = 0.78,
  while `0x50` varies per cell (0.409, 0.564, 0.478, 0.471, 0.457) — a draftsman
  condensing each label to fit its column. The five lines of the legal notice in
  the same title block behave identically: `0x58` constant, `0x50` nudged per
  line to justify the paragraph.
* **Nothing overflows.** Taking `0x50` as the advance, not one of 1,365
  horizontal strings runs past the next vertical rule to its right. Taking
  `0x58` instead, 8.5 % of them do.
* **The proportions are ordinary.** With `0x50` as the advance the width/height
  ratio lands between 0.5 and 0.75 across every sample — the usual range for
  CAD lettering. The other way round it would be 1.3 to 2.0, i.e. characters
  twice as wide as they are tall.

**The float width is a real version difference**, not a heuristic: 5.2 and 5.4
files store two doubles here, 6.0 and 7.0 store two 32-bit floats followed by
four unused bytes. Reading the wrong one yields denormal garbage, so it is easy to
confirm.

If bit `0x80` of `0x61` is set, the string does **not** live at `0x62` (whatever
is there is stale buffer contents). It lives in the **next record**, starting at
offset `0x02`, with length `0x61 & 0x7F` — up to 126 characters. That entity
therefore consumes two records.

`(0x1C, 0x24)` is the **lower-left** of the string, and the string occupies
`len × advance` drawing units. Confirmed by overlaying computed text boxes on a
title block and checking they land inside their cells.

The stroke font itself is not in the file. A viewer has to substitute; because
the advance is a fixed value per character, a monospaced font is the closest
match.

### 3.4 Type 5 — linear dimension

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | ΔX of the measured span |
| `0x58` | f64 | ΔY of the measured span |
| `0x60` | f64 | perpendicular offset of the dimension line |
| `0x68` | f64 | half-width of the gap left for the label |
| `0x70` | f64 | position of that gap's centre along the span |
| `0x3C` | f64 | rotation, radians |
| `0x79` | bit `0x80` | measured axis: set = horizontal (use ΔX), clear = vertical (use ΔY) |

`(0x1C, 0x24)` is the first measured point; the second is `(x+Δx, y+Δy)`. Only
one component is measured — the flag says which — so a dimension between two
points at different heights still reports a purely horizontal or vertical
distance, and the two witness lines simply come out different lengths.

**The label is not in this record.** It is an ordinary type 4 text entity in the
**following** record, drawn in the normal way; the dimension only needs it to
size its arrowheads. All 136 dimensions in the corpus are followed by a text
record, without exception.

The axis flag was confirmed arithmetically: `0x70` should land at the middle of
the span, and `|measured| / 2 == value@0x70` holds for **122 of 136** records
when the axis is chosen by the flag, against **1 of 136** with the axes
swapped. The fourteen that miss are dimensions whose label was dragged off
centre along the line, which is exactly what that field is for.

Nothing in the record describes the arrowheads or the tick style, so a viewer
has to choose: this one draws barbed arrows scaled to 0.65 × the label height
and capped at a fifth of the span.

### 3.5 Type 6 — cubic Bézier

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50`, `0x58` | f64 | control point 1, **relative to** `(x, y)` |
| `0x60`, `0x68` | f64 | control point 2, relative |
| `0x70`, `0x78` | f64 | end point, relative |

Consecutive Bézier entities chain: each one's end point is the next one's start
point, which is how VersaCAD stores a spline.

### 3.6 Type 8 — symbol insert

| Offset | Type | Meaning |
|--------|------|---------|
| `0x1C`, `0x24` | f64 | insertion point |
| `0x3C` | f64 | rotation, radians |
| `0x50` | char[9] | symbol **group** name |
| `0x59` | u16 | symbol id — **the symbol's index is this value ÷ 2** |
| `0x6B` | f64 | X scale (negative mirrors) |
| `0x73` | f64 | Y scale |

The `÷ 2` looks odd but resolves all 617 inserts across the samples with no
misses and no ambiguity; the low bit carries something else. A symbol is
identified by the pair *(group name, id ÷ 2)* — the index alone is not unique,
since indices restart per group.

The placement transform is

```
world = T(insertion) · R(rotation) · S(scaleX, scaleY) · T(−symbol base point)
```

### 3.7 Types not decoded

Types 7 (1 record) and 9 (5) carry geometry that is not identified — type 9
looks like an angular dimension or a leader, carrying an angle at `0x3C` and a
radius. Together they are well under **0.1 %** of the objects in the sample
set. The reader skips them and reports the count.

---

## 4. Symbols

### Symbol table record (tag `0x58`)

| Offset | Type | Meaning |
|--------|------|---------|
| `0x02` | char[9] | group name (e.g. `fas`, `brg`, `jim`) |
| `0x0B` | char[11] | symbol name (e.g. `sh5`, `manf`) |
| `0x14` | u16 | index within the group |
| `0x16` | u16 | **absolute record index** where the symbol body starts |
| `0x18` | u16 | number of records in the body |
| `0x1A`, `0x22` | f64 | symbol extent |
| `0x2A`, `0x32` | f64 | symbol **base point** — what an insert aligns to |

The bodies referenced by the table tile part 2 of the entity section exactly,
end to end, which is a strong confirmation that `0x16`/`0x18` are read right.

### Symbol body

A body is an ordinary run of entity records. Its **first record carries tag
`0x66` instead of `0x64`** — but it is still a full entity and must be drawn.
It is easy to mistake for a pure header and skip, which silently loses one
object per symbol: in these drawings that object is the *head* of the figure
used for scale, so it disappears from every placement. The give-away is that
the symbol table's declared extent only closes if the `0x66` record is counted
— for `jim/manf` its ellipse tops out at 68.299 against a declared 68.293.

Geometry is stored in the drawing's own coordinates around the symbol's base
point, so placing it means translating by `insertion − base`, then scaling and
rotating. Bodies may contain further inserts; nesting is supported.

---

## 5. Line types and pens

The file stores only *numbers*. The pen-to-colour mapping and the dash patterns
lived in VersaCAD's configuration, not in the drawing, so any viewer has to
supply its own. `web/js/vcad-style.js` uses conventional CAD equivalents:

| # | Line type used here |
|---|---------------------|
| 1 | continuous |
| 2 | hidden |
| 3 | dotted |
| 4 | centre |
| 5 | phantom |
| 6 | dash-dot |
| 7 | long dash |
| 8 | short dash |

Line type 1 (continuous) and 4 (centre) are confirmed by inspection. The rest
are plausible assignments in the usual drafting order.

---

## 6. Saved views (tags `0x48`, `0x50`)

Between the header and the entities sits a run of records holding four doubles
and a short name (`1`, `2`, `title`, `af`, `rw`, …). `0x50` records carry extra
doubles that look like a plot scale and sheet size. These are saved views and
plot setups; they hold no drawing content and are skipped.

---

## 7. How this was checked

* The reference reader (`tools/parse.py`) walks all eleven files using only the
  header section counts and hits the zero padding exactly, with **no
  unrecognised records**.
* The browser reader (`web/js/vcad-parse.js` + `vcad-geom.js`) is compared
  against the Python reference primitive by primitive — 23,387 primitives,
  byte-identical output.
* Exported DXF is read back and compared with the source geometry: total path
  length within 0.25 %, bounding box to 5 decimal places, and every text string
  preserved.
* Drawings were rendered and inspected visually at several zoom levels.

Run `python tools/verify.py` to reproduce all of it.

## 8. What is still unknown

* Byte `0x00` flags, bit `0x80` of byte `0x73`, and the high nibble of the
  subtype byte `0x4E`.
* Entity types 7 and 9.
* Bytes `0x03`, `0x04` and `0x06` of the entity shell.
* The exact meaning of the low bit of the insert's symbol id.
* Header records 2–6 beyond the extents (grid, snap, dimension defaults).
* The stroke fonts, and the real dash pattern table — both lived outside the
  drawing file.
