# The VersaCAD `.2D` drawing format

There is no published specification for this format. Everything below was
reverse engineered from a working set of fifteen drawings spanning VersaCAD
5.2, 5.4, 6.0 and 7.0, and then re-checked field by field against a much
larger corpus: **3,007 drawings containing 2,419,915 entities**, the same four
versions (611 / 1,421 / 707 / 262 files). Every count below is from that full
corpus unless it says otherwise. The drawings are not redistributed with this
repository, so the evidence for each reading is quoted as counts and
measurements rather than as a pointer to a particular file.

Working from fifteen drawings and then from three thousand is a different
exercise, and the difference is recorded honestly here: several readings that
looked exact at the small scale turned out to be approximations, and where
that happened the section says so rather than quietly restating the number.

Confidence is noted per field: **solid** means it is exercised by every drawing
in that set and validated by rendering or by a round trip; **inferred** means
the reading is consistent with the data but not independently confirmed.

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
| `0x64`, `0x65`, `0x66` | a drawing entity (§3) — the low two bits are flags |
| `0x58`, `0x5C` | a symbol table entry (§4) |
| `0x00` | trailing zero padding |

An entity's tag is `0x64` with two flag bits over it, and both flags are still
only partly understood. `0x66` opens the symbol-body section in 887 of the 894
drawings that have one, which is where the "first record of a symbol body"
reading (§4) comes from — but it also appears on 2,158 entities in the *main*
section, where there are no symbol bodies for it to open, so that cannot be all
it means. `0x65` appears on 696 records, 645 lines and 51 arcs. `0x67` has not
been seen at all.

Whatever the flags mean, the records under them are byte-for-byte the same
shape as any other entity and carry real geometry, so all three tags must be
accepted and drawn. Dropping `0x65` and `0x66` would lose 6,762 entities.

Records are **not** self-describing about length. A text entity whose string is
too long to fit inline is followed by one continuation record whose bytes are
raw string data — the tag byte of such a record is just a character, and
`0x64`–`0x67` are `d` to `g`. So the tag doubles as a desync guard: accept only
the three tags actually observed, and a walk that loses its place complains
instead of drawing nonsense. The only reliable way to walk the file is the
section counts in the header plus the per-entity "consumed records" rule in
§3.4.

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

This is exact for every one of them: the computed end always lands precisely on
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

Every entity record (tag `0x64`, `0x65` or `0x66`) shares this frame:

| Offset | Type | Meaning | Confidence |
|--------|------|---------|-----------|
| `0x00` | u8 | flags (bit 3 and bit 7 are common; meaning unknown) | unknown |
| `0x01` | u8 | tag: `0x64`, `0x65` or `0x66` (see §1) | solid |
| `0x02` | u8 | level / group number, 0–30 observed | inferred |
| `0x05` | u8 | **pen** number, 1–7 | solid |
| `0x07` | u8 | **line type** number, 1–8 | solid |
| `0x1C` | f64 | X — start point, centre, insertion point, or text origin | solid |
| `0x24` | f64 | Y | solid |
| `0x3C` | f64 | rotation in radians (arcs, text, symbol inserts) | solid |
| `0x44` | char[7] | part / layer name, NUL-padded (`new` is the default) | solid |
| `0x4E` | u8 | subtype — **low nibble is the entity type** | solid |
| `0x73` | u8 | flag byte on lines and arcs; bit `0x40` is the arc sweep direction (§3.3) | solid |
| `0x79` | u8 | on dimensions, the top two bits are the measured axis (§3.5) | solid |

The high nibble of `0x4E` takes every value 0–15 and is not needed to draw; it
tracks with drawing structure rather than appearance.

`0x73` and `0x79` are flag bytes only for the types whose fields stop short of
them. A line uses `0x50`–`0x5F` and nothing further, so `0x73` is free and
holds only 0, `0x40`, `0x80` or `0xC0`; the same is true of arcs. On a text,
dimension, Bézier or symbol insert those offsets fall inside real data and take
arbitrary values, so a flag must never be read from them without first
checking the entity type.

Pen and line type were confirmed by colour-coding drawings by each byte: pen
separates sheet border, geometry and annotation onto different plotter pens,
and line type 4 picks out exactly the axis centrelines of turned parts.

---

## 3. Entity types (low nibble of `0x4E`)

### 3.1 Type 1 — line

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | ΔX |
| `0x58` | f64 | ΔY |

The end point is `(x + Δx, y + Δy)`. Lines are the most common entity by far.

### 3.2 Type 2 — rectangle

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | ΔX to the opposite corner |
| `0x58` | f64 | ΔY to the opposite corner |
| `0x3C` | f64 | rotation about the first corner, radians |

Stored exactly like a line (§3.1) — `(0x1C, 0x24)` is one corner and the delta
reaches the diagonally opposite one — but drawn as the four sides of the box.

**The rotation is not optional.** 101 of the 1,425 rectangles in the corpus
carry a non-zero angle at `0x3C`, so ignoring the field misplaces one rectangle
in fourteen. The clearest demonstration is a set of three small rectangles that
plug gaps in a run of vertical lines: all three measure 0.5156 × 0.5781, and
two of them span the same Y band directly. The third carries a half turn; only
once that is applied does it span that band too instead of sitting one
box-height above it. Each rectangle is then centred to the last decimal on the
vertical line above it, which stops at its top edge — the box fills the gap
exactly.

Some drawings consist of a single rectangle and nothing else, and render as an
empty sheet if the type is skipped.

### 3.3 Type 3 — arc / elliptical arc

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

* Byte `0x73` holds only 0, `0x40`, `0x80` or `0xC0` on arcs — a clean flag
  field rather than data. It is set on 120,952 of the 193,704 arcs.
* Honouring it turns the distribution of sweep sizes from near-uniform into the
  shape draughting actually produces. Of the 96,943 arcs that are not full
  turns, honouring the bit gives **55 % at or below 90° and 88 % at or below
  180°**, with only 3 % beyond 270°. Ignoring it gives 29 % / 54 % / 21 %, and
  inverting it gives 3 % / 19 % / 34 % — the last being the mirror image, which
  is exactly what a direction flag read backwards should look like.
* It shows up directly on screen. Small curved details built from short arcs
  render as near-complete loops when the bit is ignored, and as the intended
  curves when it is honoured.

An earlier version of these notes claimed the bit is never set on a line
record. That was true of fifteen drawings and is false of three thousand: it is
set on 14,080 lines. Byte `0x73` is just as much a free flag byte on a line as
on an arc (§2), so the bit is not arc-specific and cannot be used to tell the
two apart. Nothing depends on that claim — the sweep direction is read only
from arc records — but the reasoning behind it was wrong.

Angles are parametric (the ellipse is traced as `C + U·cos t + V·sin t`); for
circles the two readings coincide, and no sample distinguishes them for
ellipses. Radii are always positive in every sample.

Bit `0x80` of the same byte is set on 4,653 arcs and 960 lines; its meaning is
unknown and ignoring it costs nothing visible.

### 3.4 Type 4 — text

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 (5.2, 5.4) / f32 (6.0, 7.0) | character **advance** (width per character) |
| `0x58` | f64 (5.2, 5.4) / f32 (6.0, 7.0) | character **height** (cap height) |
| `0x3C` | f64 | rotation, radians |
| `0x60` | u8 | font number (1–12 observed; 4 and 5 are 97 % of all text) |
| `0x61` | u8 | string length, with bit `0x80` as a flag — see below |
| `0x62` | char[30] | the string, when it fits inline |

The width-before-height order is easy to get backwards, so it is worth the
evidence. Three independent checks all point the same way:

* **Table rows share a height, not a width.** Five column headers sitting on
  one row of a title-block table all carry `0x58` = 0.78, while `0x50` varies
  per cell (0.409, 0.564, 0.478, 0.471, 0.457) — a draftsman condensing each
  label to fit its column. A five-line justified paragraph behaves the same
  way: `0x58` constant, `0x50` nudged per line to make the lines flush.
* **Nothing overflows.** Taking `0x50` as the advance, 77 of 315,712 strings
  (0.02 %) come out wider than the whole drawing. Taking `0x58` instead, four
  times as many do. Against the tighter test — whether a string runs past the
  next vertical rule to its right — the gap on a sample of title blocks was
  starker still, nothing against 8.5 %.
* **The proportions are ordinary.** With `0x50` as the advance the
  advance/height ratio lands in 0.4–0.8 for **95.9 %** of all 315,712 strings
  and at or below 0.9 for 96.9 %, clustering at 0.5–0.6 — the usual range for
  CAD lettering. The other way round every one of those becomes 1.25 to 2.5,
  i.e. characters twice as wide as they are tall.

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

### 3.5 Type 5 — linear dimension

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50` | f64 | ΔX of the measured span |
| `0x58` | f64 | ΔY of the measured span |
| `0x60` | f64 | perpendicular offset of the dimension line |
| `0x68` | f64 | half-width of the gap left for the label |
| `0x70` | f64 | position of that gap's centre along the span |
| `0x3C` | f64 | rotation, radians |
| `0x79` | bits 6–7 | measured axis: **2** = horizontal (use ΔX), **1** = vertical (use ΔY), **0** = unstated |

`(0x1C, 0x24)` is the first measured point; the second is `(x+Δx, y+Δy)`. Only
one component is measured — the flag says which — so a dimension between two
points at different heights still reports a purely horizontal or vertical
distance, and the two witness lines simply come out different lengths.

**The label is not in this record.** It is an ordinary type 4 text entity in the
**following** record, drawn in the normal way; the dimension only needs it to
size its arrowheads. 39,238 of the 40,510 dimensions in the corpus — 96.9 % —
are followed by a text record.

**The axis is a two-bit code, not a flag.** The natural test is the 16,583
records where exactly one of ΔX and ΔY is zero, because there the file *must*
select the non-zero component: selecting the zero one measures nothing and
draws nothing. Split those by the top two bits of `0x79` and the field reads
itself:

| `0x79 >> 6` | measures ΔX | measures ΔY | reading |
|---|---:|---:|---|
| 2 | 8,899 | 0 | horizontal |
| 1 | 0 | 6,913 | vertical |
| 0 | 454 | 317 | no axis stated |
| 3 | — | — | never occurs |

Codes 1 and 2 are never once contradicted, across all 39,235 records that carry
them — including the 23,423 where both components are non-zero and the code is
the only thing that says which one is meant. Code 0 appears on 1,275 records
(3.1 %) and states nothing; searching every bit of every byte in those records
finds no field that recovers the axis, only proxies that are really just
detecting which component is non-zero.

So a reader should take the code where there is one and fall back on the
geometry where there is not: if the code is 0, measure whichever component is
non-zero, and only then default. That leaves no dimension in the corpus
drawing nothing.

**This replaces a single-bit reading that was wrong.** Bit `0x40` of `0x79`
read inverted is exactly "is the code 1?", so it agrees with the code on
everything except code 0, and it scores 16,266 of 16,583 — 98.1 %, and 66 of 66
on the fifteen-drawing set, which is why it looked exact. The 317 it misses are
code-0 records measuring ΔY, and every one of them rendered as nothing at all.
A near-miss flag that fails silently is worse than an obviously wrong one.

An independent check agrees with the code. `0x70` should land at the middle of
the span, and `|measured| / 2 == value@0x70` holds exactly for **18,430**
records with the axis chosen by the code, against **31** with the axes swapped.
The rest miss because their label was dragged off centre along the line, which
is what that field is for.

Nothing in the record describes the arrowheads or the tick style, so a viewer
has to choose: this one draws barbed arrows scaled to 0.65 × the label height
and capped at a fifth of the span.

### 3.6 Type 6 — cubic Bézier

| Offset | Type | Meaning |
|--------|------|---------|
| `0x50`, `0x58` | f64 | control point 1, **relative to** `(x, y)` |
| `0x60`, `0x68` | f64 | control point 2, relative |
| `0x70`, `0x78` | f64 | end point, relative |

Consecutive Bézier entities chain: each one's end point is the next one's start
point, which is how VersaCAD stores a spline.

### 3.7 Type 7 — dimension arrowhead

| Offset | Type | Meaning |
|--------|------|---------|
| `0x1C`, `0x24` | f64 | the arrow's **tip** |
| `0x3C` | f64 | the direction it points, radians |

That is the whole record in 3,274 of the 3,370 examples: a point, a direction,
and zero from `0x50` to the end. It is a free-standing arrowhead, not attached
to a dimension entity — the head is the entity, and the line it terminates is
an ordinary type 1 line.

They are placed by hand and it shows. 72.8 % of the stored rotations are an
exact multiple of 90°, and 95 % are a whole number of degrees. 2,744 of the
3,370 sit in adjacent pairs, but those pairs are not what a two-record sample
suggests: only 10.6 % of them point 180° apart, while 64.2 % point the *same*
way. The dominant use is the chained dimension string of an architectural plan
— a run of heads marching along a line of witness marks at equal spacing, two
of them landing on the same point wherever one dimension ends and the next
begins.

The pair that gives the type away is a different, rarer arrangement: two heads
planted on the two walls of a tube, one tip on the inner arc and the other on
the outer, each to the last decimal place stored, both at the same bearing from
the common centre, pointing at each other across the wall. Their separation
equals the wall thickness the neighbouring text calls out.

Nothing in the record gives a size, so the viewer picks one: the same barbed
head the dimensions use, at 0.65 × the drawing's median lettering height.

**The 96 records with a non-zero tail are not geometry.** They all sit in one
drawing, and they carry what looks like a promising Δx/Δy at `0x50`/`0x58` —
the same slot a line uses, holding round values from 3 to 18 units. Drawing
them puts long strays through the sheet and off its edges, matching nothing.
They are stale buffer contents, the same hazard §3.4 documents at `0x62`, and
the tail of a type 7 record should be ignored however inviting it looks.

### 3.8 Type 8 — symbol insert

| Offset | Type | Meaning |
|--------|------|---------|
| `0x1C`, `0x24` | f64 | insertion point |
| `0x3C` | f64 | rotation, radians |
| `0x50` | char[9] | symbol **group** name |
| `0x59` | u16 | symbol id — **the symbol's index is this value ÷ 2** |
| `0x6B` | f64 | X scale (negative mirrors) |
| `0x73` | f64 | Y scale |

The `÷ 2` looks odd but resolves every insert in the set with no misses and no
ambiguity; the low bit carries something else. A symbol is identified by the
pair *(group name, id ÷ 2)* — the index alone is not unique, since indices
restart per group.

The placement transform is

```
world = T(insertion) · R(rotation) · S(scaleX, scaleY)
```

**The symbol body's own origin is what lands on the insertion point.** There is
no base point in this transform, which is the trap: the symbol table does carry
a point (§4) that looks like an insertion base, and subtracting it drags every
placement off by that offset. Two independent checks say not to:

* A fastener symbol's washer circle sits at its body's local base-point
  coordinates, and must end up on a drilled hole in the part. Across 468
  inserts with a non-zero base point, the circle lands on an existing hole in
  **59** cases if the base is *not* subtracted, and in **0** cases if it is.
* Where several copies of a standing figure are placed along one floor line,
  their insertion points share a Y value that matches a long horizontal line in
  the drawing to two decimal places. Their feet — local Y = 0 in the body —
  reach it only without the subtraction. With it they scatter, because the
  offset is rotated and mirrored differently for each copy.

### 3.9 Type 9 — angular dimension

| Offset | Type | Meaning |
|--------|------|---------|
| `0x3C` | f64 | start angle of the measured wedge, radians |
| `0x68` | f64 | vertex to the **inner** end of the witness lines |
| `0x60` | f64 | inner end **outward to the arc** — the two sum to the arc radius |
| `0x70` | **f32** | the measured angle (the sweep), signed |
| `0x74` | **f32** | half-width of the gap left for the label, radians |
| `0x78` | **f32** | position of that gap's centre along the sweep, radians |

The layout mirrors the linear dimension (§3.5) with angles in place of
distances, and like it the label is the type 4 text entity in the **following**
record.

**`(0x1C, 0x24)` is not the vertex.** It is where the first witness line
starts, `0x68` out from the vertex along the start angle and just clear of the
feature being measured, so the vertex has to be recovered:

```
vertex   = (x, y) − 0x68 · (cos startAngle, sin startAngle)
arc drawn at radius 0x68 + 0x60, witness lines spanning 0x68 to that radius
```

Both halves of that are checkable. Recovering the vertex lands it exactly — to
the last decimal place stored — on the common centre of the concentric arcs and
radial lines making up the hub being dimensioned; using `0x60` for the same job
misses every time. And the two radii have to be summed, not used singly: the
label sits in the break in the arc, so the distance from the vertex to it
should match the arc radius. Across the 936 angular dimensions whose label can
be located, `0x68 + 0x60` matches that distance for **93.6 %** and `0x68` alone
for **28.6 %**. Taking `0x68` alone leaves the arc drawn short, stranded well
inside its label.

The three trailing values are 32-bit floats even in 5.2 files, unlike text
sizing (§3.4) which is version-dependent. The sweep is signed and can be stored
as its positive complement, so fold it into (−π, π]: a stored 330° is a 30°
angle measured the other way round. The check that this is right is that the
gap centre then lands at half the sweep, which is where an untouched label
sits. That holds exactly for 43.1 % of the 970 angular dimensions, in both
signs; the remainder are labels the draughtsman slid along the arc, the same
pattern the linear dimensions show at `0x70`. On the fifteen-drawing set it
held for every record, which was luck rather than a stronger rule.

Nothing in the record repeats the measured angle in degrees; that only exists
as the label text, which the draughtsman could and sometimes did edit.

### 3.10 Coverage

Every entity type appearing in the corpus is decoded. Across 2,419,915
entities in 3,007 drawings the low nibble of `0x4E` takes nine values, 1
through 9, and each has a section above; nothing is left over, and no drawing
contains a type outside that range.

| Type | | Records |
|---|---|---:|
| 1 | line | 1,823,017 |
| 2 | rectangle | 1,425 |
| 3 | arc / elliptical arc | 193,704 |
| 4 | text | 315,740 |
| 5 | linear dimension | 40,510 |
| 6 | cubic Bézier | 5,810 |
| 7 | dimension arrowhead | 3,370 |
| 8 | symbol insert | 35,369 |
| 9 | angular dimension | 970 |

That is a statement about this corpus, not about the format. VersaCAD could
draw things none of these drawings use, and the policy for meeting one is
unchanged.

The policy for anything unrecognised is the same throughout, and does not
depend on which drawing is open: a record whose entity type is not understood
is skipped and counted, and a record whose tag is not one of the three known
entity tags is skipped and reported as a warning. Both counts are surfaced in
the viewer — unknown types under **Not drawn**, unreadable records as **Skipped
records** — so a drawing that is quietly missing something says so instead of
just looking subtly wrong. Nothing is invented to fill the gap.

---

## 4. Symbols

### Symbol table record (tags `0x58`, `0x5C`)

| Offset | Type | Meaning |
|--------|------|---------|
| `0x02` | char[9] | group name, NUL-padded (a library name such as fasteners or bearings) |
| `0x0B` | char[11] | symbol name within that group, NUL-padded |
| `0x14` | u16 | index within the group |
| `0x16` | u16 | **absolute record index** where the symbol body starts |
| `0x18` | u16 | number of records in the body |
| `0x1A`, `0x22` | f64 | symbol extent |
| `0x2A`, `0x32` | f64 | a reference point *inside* the body — **not** the placement origin (§3.8) |

The bodies referenced by the table tile part 2 of the entity section exactly,
end to end, which is a strong confirmation that `0x16`/`0x18` are read right.

One drawing in the corpus carries 21 of these records under tag `0x5C` rather
than `0x58`, with names in the same places, so `0x5C` looks like the same
record with a flag bit set — the same relationship `0x66` has to `0x64` (§1).
Five other drawings have a handful of symbol table records sitting past the end
of the region the header's symbol count implies, so that count can under-report
and a reader should not treat it as a hard boundary.

### Symbol body

A body is an ordinary run of entity records. Its **first record carries tag
`0x66` instead of `0x64`** — but it is still a full entity and must be drawn.
It is easy to mistake for a pure header and skip, which silently loses one
object per symbol — and since a symbol is typically placed many times over, a
single dropped record can account for a lot of absent geometry. The give-away
is arithmetic: the symbol table's declared extent only closes when the `0x66`
record is counted. In one symbol that record is an ellipse whose top lands at
68.299, against a declared extent of 68.293.

Geometry is stored in the body's own coordinate system, whose origin is what
lands on the insertion point — so placing it means scaling and rotating about
that origin and translating to the insertion point, with no base-point
correction (§3.8). Bodies may contain further inserts; nesting is supported.

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

* The reference reader (`tools/parse.py`) walks every drawing in the set using
  only the header section counts and hits the zero padding exactly, with **no
  unrecognised records**.
* The browser reader (`web/js/vcad-parse.js` + `vcad-geom.js`) is compared
  against the Python reference primitive by primitive — 27,050 primitives,
  byte-identical output.
* Exported DXF is read back and compared with the source geometry: total path
  length within 0.25 %, bounding box to 5 decimal places, and every text string
  preserved.
* Drawings were rendered and inspected visually at several zoom levels.
* Every field reading above was re-tested against **3,007 drawings and
  2,419,915 entities**, roughly a hundred times the set it was worked out on.
  That pass found no unknown entity type, and corrected three readings that had
  looked exact at the smaller scale: the dimension axis (§3.5), the claim that
  the arc direction bit never appears on lines (§3.3), and the assumption that
  a type 7 record's tail is always zero (§3.7).

Run `python tools/verify.py` to reproduce the first four.

Twelve drawings in the large corpus do not walk cleanly, none of them because
of an entity: six have header section counts that run past the end of the file,
five carry symbol table records past the boundary the header's symbol count
implies, and one has a single record whose tag is a one-bit corruption of
`0x64`.

## 8. What is still unknown

* Byte `0x00` flags, bit `0x80` of byte `0x73`, and the high nibble of the
  subtype byte `0x4E`.
* Both flag bits of the entity tag: `0x66` opens a symbol body but also occurs
  where there is no symbol body, and `0x65` is unexplained (§1).
* What distinguishes axis code 0 from codes 1 and 2 on a dimension (§3.5).
* Whether `0x5C` differs from `0x58` in a symbol table record, or is only a
  flag over the same layout (§4).
* Bytes `0x03`, `0x04` and `0x06` of the entity shell.
* The exact meaning of the low bit of the insert's symbol id.
* Header records 2–6 beyond the extents (grid, snap, dimension defaults).
* The stroke fonts, and the real dash pattern table — both lived outside the
  drawing file.
