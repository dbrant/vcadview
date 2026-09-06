# vcadview — viewer and converter for VersaCAD `.2D` drawings.

Dmitry Brant, 2026, feat. Claude Code.
No affiliation with VersaCAD; For research and educational purposes only.

([Live web demo](https://rivendell.dmitrybrant.com/vcadview))

A browser-based viewer and converter for VersaCAD `.2D` drawings, the binary
format used by the DOS/Windows drafting package of the same name. The format is
undocumented; it was reverse engineered from drawings discovered in recovered backup archives,
and the findings are written up in [`docs/FORMAT.md`](docs/FORMAT.md).

Everything runs client-side (no server, no uploads, the
drawings never leave the machine).

## Using it

Open **`dist/vcadview.html`** directly from disk and drag `.2D` files onto it.
That is the whole install — the three files in `dist/` need no server and make
no network requests, and plain `<link>` and `<script src>` tags both work from
a `file://` URL.

While editing, use `web/index.html` instead: same code, but as the eight
separate source files rather than the combined pair.

Rebuild `dist/` after changing anything under `web/`:

```
python tools/bundle.py
```

To minify the combined JavaScript for distribution, install the build-only
dependency once, then add `--minify`:

```
npm install
python tools/bundle.py --minify
```

The build concatenates the six scripts into one `vcadview.js` and the
stylesheet into one `vcadview.css`. Markup, styling and behaviour stay in
separate files at every stage; nothing is ever inlined into the HTML.

### Viewing

| Action | |
|---|---|
| pan | drag |
| zoom | mouse wheel (zooms at the cursor) |
| zoom to a window | shift + drag, or right-drag |
| fit the drawing | `F`, or double-click |
| zoom in / out | `+` / `-` |

Drop several files at once to load them together and switch between them in the
side panel.

The side panel reports what is in the drawing and lets you switch off individual
**parts/layers**, **pens** or **line types**. Those filters apply to exports as
well, so you can, for example, export just the geometry without the annotation
pen.

The interface theme is a **Light / Dark / Auto** picker in the header; Auto
follows the operating system, and the choice is remembered between sessions.
It is deliberately separate from the **dark drawing sheet** option in the side
panel, so you can keep a white "paper" sheet under a dark interface, or the
reverse.

Other display options cover text on/off, dashed line types on/off, monochrome,
and line weight.

### Converting

| Format | Notes |
|---|---|
| **DXF** | R12 (`AC1009`), the most widely readable flavour. Symbols become `BLOCK`/`INSERT` so the drawing keeps its structure. Lines, circular arcs and text stay as native entities; elliptical arcs and Béziers are flattened to polylines, because R12 has neither an `ELLIPSE` nor a `SPLINE` entity. Pens map to entity colours, VersaCAD parts to layers, and line types to `LTYPE` definitions. |
| **SVG** | Vector, one path per pen/line-type combination, with real `<text>` elements. Good for the web or for dropping into a document. |
| **PDF** | Vector, single page, choice of sheet size from A4 to A1 plus US Letter and Tabloid. Text is real selectable text in Courier, whose fixed pitch matches how VersaCAD spaces characters. |

## What is supported

Lines, circular and elliptical arcs, cubic Bézier curves, text (including the
multi-record continuation form used for long strings), linear dimensions
(witness lines, arrowheads and the gap left for the label), and symbol
placement with rotation, scaling and mirroring, nested to any depth. Pens, line
types, part names and the drawing's own extents are read.

VersaCAD **5.2, 5.4, 6.0 and 7.0** files all load; the reader detects the
version and adapts, which matters because text sizing changed from `double` to
`float` between 5.4 and 6.0. The version word is simply the release number
times ten, so newer releases name themselves correctly too.

Three rare entity types — 11 records out of 22,600 in the sample drawings
— are not yet identified. They are skipped rather than guessed at, and the
side panel reports them under **Not drawn**, so a drawing that is quietly
missing something says so. See §3.7 and §8 of the format notes.

Two things cannot be recovered from a `.2D` file because they were never in
it: the **stroke fonts** and the real **dash pattern table**, both of which
lived in VersaCAD's configuration. The viewer substitutes a monospaced font
and conventional CAD dash patterns scaled to the drawing size.

A drawing does store a per-character advance, so text is laid out at the
right pitch, but a substitute font fills that advance differently from the
original strokes. `TEXT_WIDTH_SCALE` in `web/js/vcad-geom.js` calibrates for
that; it is applied wherever text is drawn, so the viewer and all three
export formats stay in agreement.

## Verifying

```
python tools/verify.py
```

This runs four checks and exits non-zero on any failure:

1. The Python reference reader parses every sample using only the header's
   section counts, with **no unrecognised records**, landing exactly on the
   file's zero padding.
2. The browser reader is compared with the Python reference **primitive by
   primitive** — 26,294 primitives across the samples, byte-identical.
3. DXF/SVG/PDF export runs, and the exported DXF is read back and compared with
   the source: total path length within 0.25 %, bounding box to five decimals,
   and every text string preserved.
4. The bundle builds into `dist/` as exactly three files, the HTML carries no
   inline CSS or JavaScript, every source file made it into the combined
   output, and no assets are loaded from outside `dist/`.

Steps 2 and 3 need Node (any recent version) on `PATH`; they are reported as
failures if it is missing. Steps 1 and 4 need only Python 3 and, for the
optional PNG rendering in `tools/`, Pillow.

## Layout

```
dist/                  the built app - open dist/vcadview.html
  vcadview.html          markup only
  vcadview.css           the stylesheet
  vcadview.js            the six scripts, concatenated in load order
web/index.html         source markup
web/css/app.css        source stylesheet (interface chrome only)
web/js/
  vcad-parse.js        .2D reader - records, sections, entities
  vcad-geom.js         entities -> display list, symbol expansion, tessellation
  vcad-style.js        pen palettes and line-type patterns
  vcad-render.js       canvas viewer with pan/zoom
  vcad-export.js       DXF / SVG / PDF writers
  app.js               UI wiring
docs/FORMAT.md         the reverse-engineered format specification
samples/               the VersaCAD drawings used to work the format out (not committed to this repo)
tools/
  verify.py            run every check
  bundle.py            build dist/ from web/
  rec.py, parse.py     Python reference reader
  dump_prims.py        reference geometry dump (compared against dump-prims.js)
  dump-prims.js        browser-code geometry dump, run under Node
  export-samples.js    write DXF/SVG/PDF for every sample
  dxfcheck.py          read exported DXF back and compare; can render to PNG
  render2.py           reference renderer, for eyeballing decode changes
  node-check.js        quick per-file statistics from the browser reader
  analysis/            the scripts used to reverse engineer the format
```

`tools/analysis/` is kept deliberately: those scripts are the evidence behind
the format notes — record tag histograms, per-offset field occupancy maps, the
arc-direction comparison, the text-extent overlay, and so on. They are useful
again if an unknown field ever needs chasing.
