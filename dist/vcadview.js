/* ==== js/vcad-parse.js ==== */
/*
 * vcad-parse.js - reader for VersaCAD .2D drawing files.
 *
 * The format was reverse engineered from sample files; see docs/FORMAT.md.
 * Everything is little-endian and laid out in fixed 128-byte records.
 */
(function (global) {
  'use strict';

  var REC = 128;

  // The version word is the release number times ten: 52 -> 5.2, 70 -> 7.0.
  function versionName(v) {
    return (v >= 10 && v <= 999) ? (v / 10).toFixed(1) : '0x' + v.toString(16);
  }

  // Entity type = low nibble of the subtype byte at 0x4e.
  var T_LINE = 1, T_RECT = 2, T_ARC = 3, T_TEXT = 4, T_DIM = 5, T_BEZIER = 6,
      T_ARROW = 7, T_INSERT = 8, T_ANGDIM = 9;

  /** Fold an angle into (-PI, PI], so a stored 330 degrees reads as -30. */
  function signedAngle(a) {
    var TAU = 2 * Math.PI;
    a = a % TAU;
    if (a > Math.PI) a -= TAU;
    if (a <= -Math.PI) a += TAU;
    return a;
  }

  function Reader(buf) {
    this.dv = new DataView(buf);
    this.u8 = new Uint8Array(buf);
    this.n = Math.floor(buf.byteLength / REC);
  }
  Reader.prototype.u16 = function (r, o) { return this.dv.getUint16(r * REC + o, true); };
  Reader.prototype.f64 = function (r, o) { return this.dv.getFloat64(r * REC + o, true); };
  Reader.prototype.f32 = function (r, o) { return this.dv.getFloat32(r * REC + o, true); };
  Reader.prototype.byte = function (r, o) { return this.u8[r * REC + o]; };
  Reader.prototype.str = function (r, o, len) {
    var s = '', base = r * REC + o;
    for (var i = 0; i < len; i++) {
      var c = this.u8[base + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  function ParseError(msg) { this.name = 'ParseError'; this.message = msg; }
  ParseError.prototype = Object.create(Error.prototype);

  function finite(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

  /**
   * Parse an ArrayBuffer holding a .2D file.
   */
  function parse(buf, name) {
    if (buf.byteLength < REC * 8) throw new ParseError('File is too small to be a VersaCAD drawing.');
    var R = new Reader(buf);

    if (R.byte(0, 0) !== 0x00 || R.byte(0, 1) !== 0x08) {
      throw new ParseError('Not a VersaCAD .2D drawing (bad header signature).');
    }

    var version = R.u16(0, 0x02);
    var entStart = R.u16(0, 0x04);
    var nPart1 = R.u16(0, 0x06);
    var nSym = R.u16(0, 0x08);
    var nPart2 = R.u16(0, 0x0a);

    var symStart = entStart + nPart1;
    var part2Start = symStart + nSym;
    var end = part2Start + nPart2;
    if (end > R.n) {
      throw new ParseError('Record counts in the header run past the end of the file ('
        + end + ' > ' + R.n + ' records).');
    }

    // Header record 1 carries the drawing extents as four doubles.
    var extents = {
      minx: R.f64(1, 0x02), maxx: R.f64(1, 0x0a),
      miny: R.f64(1, 0x12), maxy: R.f64(1, 0x1a)
    };

    // ---- symbol table -------------------------------------------------
    var symbols = {};
    var symbolList = [];
    for (var i = 0; i < nSym; i++) {
      var r = symStart + i;
      var s = {
        group: R.str(r, 0x02, 9),
        name: R.str(r, 0x0b, 11),
        index: R.u16(r, 0x14),
        start: R.u16(r, 0x16),
        count: R.u16(r, 0x18),
        extX: R.f64(r, 0x1a), extY: R.f64(r, 0x22),
        baseX: R.f64(r, 0x2a), baseY: R.f64(r, 0x32)
      };
      symbols[s.group + ' ' + s.index] = s;
      symbolList.push(s);
    }

    // ---- entities -----------------------------------------------------
    var entities = [];      // main-section entities, in file order
    var byRecord = {};      // record index -> entity (both sections)
    var warnings = [];

    function readEntity(r) {
      var sub = R.byte(r, 0x4e);
      var e = {
        rec: r,
        sub: sub,
        type: sub & 0x0f,
        subGroup: sub >> 4,
        flags: R.byte(r, 0x00),
        level: R.byte(r, 0x02),
        pen: R.byte(r, 0x05),
        ltype: R.byte(r, 0x07),
        part: R.str(r, 0x44, 7),
        x: finite(R.f64(r, 0x1c), 0),
        y: finite(R.f64(r, 0x24), 0),
        rot: finite(R.f64(r, 0x3c), 0),
        consumed: 1
      };
      if (e.rot < -7 || e.rot > 7) e.rot = 0;

      switch (e.type) {
        case T_LINE:
          e.kind = 'line';
          e.dx = finite(R.f64(r, 0x50), 0);
          e.dy = finite(R.f64(r, 0x58), 0);
          break;
        case T_RECT:
          // A rectangle, stored exactly like a line: one corner and the offset
          // to the opposite one. The rotation at 0x3C turns it about the first
          // corner, and is not optional -- one rectangle only lines up with its
          // neighbours once its half turn is applied.
          e.kind = 'rect';
          e.dx = finite(R.f64(r, 0x50), 0);
          e.dy = finite(R.f64(r, 0x58), 0);
          break;

        case T_ARC:
          e.kind = 'arc';
          e.rx = finite(R.f64(r, 0x50), 0);
          e.ry = finite(R.f64(r, 0x58), 0);
          e.a1 = finite(R.f64(r, 0x60), 0);
          e.a2 = finite(R.f64(r, 0x68), 0);
          // Sweep direction. Between two angles there are two possible arcs;
          // this bit picks which one. It is never set on a line record, and
          // honouring it turns the sweep-size distribution from near-uniform
          // into the 90-degrees-or-less shape real drafting produces.
          e.cw = (R.byte(r, 0x73) & 0x40) !== 0;
          break;
        case T_TEXT:
          e.kind = 'text';
          // 0x50 is the per-character advance, 0x58 the cap height.
          // 5.2 and 5.4 store both as doubles; 6.0 and 7.0 use 32-bit floats.
          if (version <= 0x36) { e.w = R.f64(r, 0x50); e.h = R.f64(r, 0x58); }
          else { e.w = R.f32(r, 0x50); e.h = R.f32(r, 0x58); }
          e.h = finite(e.h, 0); e.w = finite(e.w, 0);
          if (e.h <= 0 || e.h > 1e6) e.h = 0;
          if (e.w <= 0 || e.w > 1e6) e.w = e.h * 0.7;
          e.font = R.byte(r, 0x60);
          var L = R.byte(r, 0x61);
          if (L & 0x80) {
            // Long strings live in the following record, starting at offset 2.
            e.text = (r + 1 < R.n) ? R.str(r + 1, 0x02, L & 0x7f) : '';
            e.consumed = 2;
          } else {
            e.text = R.str(r, 0x62, L);
          }
          break;
        case T_DIM:
          // A linear dimension: the witness lines, the offset dimension line
          // broken for the label, and two arrowheads. The label itself is the
          // ordinary text entity in the *following* record, which is drawn on
          // its own; this record only needs it for sizing the arrows.
          e.kind = 'dim';
          e.dx = finite(R.f64(r, 0x50), 0);
          e.dy = finite(R.f64(r, 0x58), 0);
          e.offset = finite(R.f64(r, 0x60), 0);    // dimension line offset
          e.gapHalf = finite(R.f64(r, 0x68), 0);   // half-width of the label gap
          e.gapMid = finite(R.f64(r, 0x70), 0);    // gap centre along the span
          // Measured axis, in the top two bits of 0x79: 2 = horizontal,
          // 1 = vertical. Those two never disagree with the geometry. Code 0
          // states no axis, so fall back on whichever component is actually
          // measured -- picking the zero one would draw nothing at all.
          var axis = R.byte(r, 0x79) >> 6;
          e.horiz = axis === 2 ? true
                  : axis === 1 ? false
                  : !(Math.abs(e.dx) < 1e-12 && Math.abs(e.dy) >= 1e-12);
          break;

        case T_ANGDIM:
          // An angular dimension. (0x1C, 0x24) is not the vertex -- it is the
          // point where the dimension arc starts, one radius out along the
          // start angle, so the vertex has to be worked back from it. As with
          // a linear dimension the label is the text entity that follows.
          e.kind = 'angdim';
          e.a0 = finite(R.f64(r, 0x3c), 0);        // start angle of the wedge
          e.r0 = finite(R.f64(r, 0x68), 0);        // vertex -> where the witness lines start
          e.rArc = e.r0 + finite(R.f64(r, 0x60), 0);   // ... and where they end, on the arc
          e.sweep = signedAngle(finite(R.f32(r, 0x70), 0));
          e.gapHalf = Math.abs(finite(R.f32(r, 0x74), 0));
          e.gapMid = signedAngle(finite(R.f32(r, 0x78), 0));
          e.vx = e.x - e.r0 * Math.cos(e.a0);
          e.vy = e.y - e.r0 * Math.sin(e.a0);
          break;

        case T_BEZIER:
          e.kind = 'bezier';
          // Three control points, stored relative to (x, y).
          e.c1x = finite(R.f64(r, 0x50), 0); e.c1y = finite(R.f64(r, 0x58), 0);
          e.c2x = finite(R.f64(r, 0x60), 0); e.c2y = finite(R.f64(r, 0x68), 0);
          e.c3x = finite(R.f64(r, 0x70), 0); e.c3y = finite(R.f64(r, 0x78), 0);
          break;
        case T_ARROW:
          // A lone dimension arrowhead: a point and a direction, and nothing
          // else -- every byte from 0x50 on is zero. Two of them, planted on
          // the two edges of a feature and pointing at each other, is how a
          // thickness gets dimensioned. Nothing states the arrow's size, so
          // the viewer scales it to the drawing's own lettering.
          e.kind = 'arrow';
          e.a0 = e.rot;
          break;

        case T_INSERT:
          e.kind = 'insert';
          e.symGroup = R.str(r, 0x50, 9);
          e.symId = R.u16(r, 0x59) >> 1;
          e.sx = finite(R.f64(r, 0x6b), 1);
          e.sy = finite(R.f64(r, 0x73), 1);
          if (e.sx === 0) e.sx = 1;
          if (e.sy === 0) e.sy = 1;
          break;
        default:
          e.kind = 'other';
      }
      return e;
    }

    function walk(start, count, into) {
      var stop = start + count, r = start, guard = 0;
      while (r < stop && guard++ <= count + 4) {
        var tag = R.byte(r, 0x01);
        // An entity record is tagged 0x64; the low two bits are flags and the
        // record is an ordinary entity whichever way they fall. 0x66 marks the
        // first record of a symbol body, 0x65 something not yet identified.
        // Both carry real geometry and must be read -- skipping 0x66 loses one
        // object per symbol, which a symbol placed many times multiplies.
        //
        // The tag is also the desync guard. A text continuation record holds
        // raw string bytes, so its "tag" is just a character -- and 0x64..0x67
        // are 'd' to 'g'. Only the three tags actually observed are accepted,
        // so a walk that loses its place still complains instead of drawing
        // nonsense.
        if (tag !== 0x64 && tag !== 0x65 && tag !== 0x66) {
          if (warnings.length < 50) {
            warnings.push('record ' + r + ': unexpected tag 0x' + tag.toString(16));
          }
          r++; continue;
        }
        var e = readEntity(r);
        byRecord[r] = e;
        if (into) into.push(e);
        r += e.consumed;
      }
    }

    walk(entStart, nPart1, entities);
    walk(part2Start, nPart2, null);

    // A representative lettering height, used to size arrowheads that carry
    // no size of their own. The median shrugs off one-off title text.
    var heights = [];
    for (var hk in byRecord) {
      if (byRecord[hk].kind === 'text' && byRecord[hk].h > 0) heights.push(byRecord[hk].h);
    }
    heights.sort(function (a, b) { return a - b; });
    var textHeight = heights.length ? heights[heights.length >> 1] : 0;

    // Attach each dimension, linear or angular, to its label: always the
    // record straight after it.
    for (var rk in byRecord) {
      var de = byRecord[rk];
      if (de.kind !== 'dim' && de.kind !== 'angdim') continue;
      var lab = byRecord[de.rec + 1];
      if (lab && lab.kind === 'text') de.label = lab;
    }

    var stats = {};
    for (var k = 0; k < entities.length; k++) {
      stats[entities[k].kind] = (stats[entities[k].kind] || 0) + 1;
    }

    return {
      name: name || 'drawing',
      version: version,
      versionName: versionName(version),
      extents: extents,
      symbols: symbols,
      symbolList: symbolList,
      entities: entities,
      byRecord: byRecord,
      sections: {
        entStart: entStart, nPart1: nPart1, symStart: symStart, nSym: nSym,
        part2Start: part2Start, nPart2: nPart2, total: R.n
      },
      warnings: warnings,
      textHeight: textHeight,
      stats: stats
    };
  }

  global.VCAD = global.VCAD || {};
  global.VCAD.parse = parse;
  global.VCAD.ParseError = ParseError;
  global.VCAD.REC = REC;
  global.VCAD.TYPES = {
    LINE: T_LINE, ARC: T_ARC, TEXT: T_TEXT, BEZIER: T_BEZIER, INSERT: T_INSERT
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/vcad-geom.js ==== */
/*
 * vcad-geom.js - turns parsed VersaCAD entities into a flat display list.
 *
 * Symbol inserts are expanded recursively. Curves stay analytic so the
 * renderer can tessellate them to whatever the current zoom deserves.
 *
 * Display-list primitives (all in world coordinates):
 *   { k:'l', x1,y1,x2,y2 }
 *   { k:'a', cx,cy, ux,uy, vx,vy, a1,a2 }   P(t) = C + U*cos t + V*sin t
 *   { k:'b', p:[x0,y0,x1,y1,x2,y2,x3,y3] }  cubic bezier
 *   { k:'t', x,y, h,w, rot, s }              text, anchored at lower-left
 * plus shared attributes: pen, ltype, level, part, sym.
 */
(function (global) {
  'use strict';

  var MAX_DEPTH = 12;

  // Matrix [a, b, c, d, e, f]:  x' = a*x + c*y + e,  y' = b*x + d*y + f
  var IDENT = [1, 0, 0, 1, 0, 0];

  function mul(m, n) {
    // returns m applied after n  (i.e. m * n)
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function applyVec(m, x, y) { return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]; }

  var TAU = 2 * Math.PI;

  /**
   * Display calibration for text, not a value from the file.
   *
   * A drawing stores a per-character advance, but not the stroke font that was
   * drawn inside it -- that lived in VersaCAD's configuration and is gone. Any
   * substitute font fills its advance differently, so the rendered lettering
   * needs a nudge to sit right on the sheet. Applied everywhere text is drawn,
   * so the viewer, SVG, PDF and DXF all agree.
   */
  var TEXT_WIDTH_SCALE = 1.25;

  /**
   * Signed sweep from a1 to a2. Two angles bound two arcs, and `cw` (from the
   * record's direction bit) says which of them the file means: false takes the
   * counter-clockwise one, true the clockwise one. a1 === a2 is a full turn.
   */
  function arcSweep(a1, a2, cw) {
    var s = (a2 - a1) % TAU;
    if (s < 0) s += TAU;                 // normalise into [0, TAU)
    if (s < 1e-12) return cw ? -TAU : TAU;
    return cw ? s - TAU : s;
  }

  /**
   * Build a linear dimension out of plain segments, in the entity's own local
   * frame (origin at its point, before its rotation is applied).
   *
   * Local layout, for a horizontal dimension measuring dx:
   *
   *      (0,0)                              (dx,dy)
   *        |  witness                   witness |
   *        |                                    |
   *     >--+------------  gap  --------------+--<   at y = offset
   *
   * A vertical dimension is the same with the axes swapped.
   */
  function dimSegments(e) {
    var horiz = e.horiz;
    var span = horiz ? e.dx : e.dy;
    var len = Math.abs(span);
    if (!(len > 1e-9)) return [];

    var off = e.offset;
    var dir = span < 0 ? -1 : 1;
    // A point `u` along the measured axis, on the dimension line.
    function at(u) { return horiz ? [dir * u, off] : [off, dir * u]; }

    var segs = [];
    var start = at(0), end = at(len);

    // Witness lines run from the two measured points out to the dimension line.
    segs.push([0, 0, start[0], start[1]]);
    segs.push([e.dx, e.dy, end[0], end[1]]);

    // Dimension line, broken where the label sits.
    var half = Math.min(Math.abs(e.gapHalf), len / 2);
    if (half < 1e-9) {
      segs.push([start[0], start[1], end[0], end[1]]);
    } else {
      var mid = Math.min(Math.abs(e.gapMid), len);
      var g0 = at(Math.max(0, mid - half));
      var g1 = at(Math.min(len, mid + half));
      segs.push([start[0], start[1], g0[0], g0[1]]);
      segs.push([g1[0], g1[1], end[0], end[1]]);
    }

    // Arrowheads: barbs swept back from each tip along the dimension line.
    var a = (e.label && e.label.h > 0) ? e.label.h * 0.65 : len * 0.08;
    a = Math.max(1e-6, Math.min(a, len * 0.2));
    var ux = horiz ? dir : 0, uy = horiz ? 0 : dir;   // unit vector, start -> end
    var px = -uy, py = ux;                            // perpendicular
    [[start, 1], [end, -1]].forEach(function (t) {
      var tip = t[0], s = t[1];
      for (var k = -1; k <= 1; k += 2) {
        segs.push([tip[0], tip[1],
                   tip[0] + ux * a * s + px * a * 0.38 * k,
                   tip[1] + uy * a * s + py * a * 0.38 * k]);
      }
    });
    return segs;
  }

  /**
   * Build an angular dimension, in a local frame whose origin is the entity's
   * own point. Returns straight pieces and arc pieces separately so the arc
   * can stay a real arc downstream instead of a polyline.
   *
   *        vertex
   *          +----------------.  witness 1, at the start angle
   *           \        __--''    )  arc at `radius`, broken for the label
   *            '--..__           )
   *                   `------.   '  witness 2, at the end angle
   */
  function angDimSegments(e) {
    var r0 = Math.abs(e.r0), r = Math.abs(e.rArc);
    if (!(r > 1e-9) || Math.abs(e.sweep) < 1e-9) return null;

    var vx = -r0 * Math.cos(e.a0), vy = -r0 * Math.sin(e.a0);   // vertex, local
    var a1 = e.a0, a2 = a1 + e.sweep, dir = e.sweep < 0 ? -1 : 1;
    var lines = [], arcs = [];

    // Witness lines run outward from the measured feature to the arc, which
    // sits far enough out for the label to sit in the break in it.
    lines.push([vx + r0 * Math.cos(a1), vy + r0 * Math.sin(a1),
                vx + r * Math.cos(a1), vy + r * Math.sin(a1)]);
    lines.push([vx + r0 * Math.cos(a2), vy + r0 * Math.sin(a2),
                vx + r * Math.cos(a2), vy + r * Math.sin(a2)]);

    // The arc, broken where the label sits.
    var half = Math.min(e.gapHalf, Math.abs(e.sweep) / 2);
    if (half < 1e-9) {
      arcs.push([vx, vy, r, a1, a2]);
    } else {
      var mid = a1 + e.gapMid;
      arcs.push([vx, vy, r, a1, mid - dir * half]);
      arcs.push([vx, vy, r, mid + dir * half, a2]);
    }

    // Arrowheads, swept back along the arc from each end.
    var a = (e.label && e.label.h > 0) ? e.label.h * 0.65 : r * 0.08;
    a = Math.max(1e-6, Math.min(a, r * Math.abs(e.sweep) * 0.3));
    [[a1, 1], [a2, -1]].forEach(function (t) {
      var ang = t[0], s = t[1] * dir;
      var tipx = vx + r * Math.cos(ang), tipy = vy + r * Math.sin(ang);
      // tangent at the tip, pointing into the arc
      var tx = -Math.sin(ang) * s, ty = Math.cos(ang) * s;
      var px = -ty, py = tx;
      for (var k = -1; k <= 1; k += 2) {
        lines.push([tipx, tipy,
                    tipx + tx * a + px * a * 0.38 * k,
                    tipy + ty * a + py * a * 0.38 * k]);
      }
    });
    return { lines: lines, arcs: arcs };
  }



  /**
   * The two barbs of an arrowhead: tip at (0,0) pointing along `ang`, swept
   * back by `a`. Shared shape with the dimension arrows so they match.
   */
  function arrowBarbs(ang, a) {
    var ux = -Math.cos(ang), uy = -Math.sin(ang);   // back along the shaft
    var px = -uy, py = ux;
    var out = [];
    for (var k = -1; k <= 1; k += 2) {
      out.push([0, 0, ux * a + px * a * 0.38 * k, uy * a + py * a * 0.38 * k]);
    }
    return out;
  }

  /** The four corners of a rectangle entity, in its own unrotated frame. */
  function rectCorners(e) {
    return [[0, 0], [e.dx, 0], [e.dx, e.dy], [0, e.dy]];
  }

  function isFullTurn(a1, a2) {
    var s = (a2 - a1) % TAU;
    if (s < 0) s += TAU;
    return s < 1e-12;
  }

  function flatten(doc, opts) {
    opts = opts || {};
    var out = [];
    var bez = 0, arcs = 0, lines = 0, texts = 0, inserts = 0, dims = 0, missing = {};

    function emitRange(start, count, m, depth, symName) {
      if (depth > MAX_DEPTH) return;
      var stop = start + count, r = start, guard = 0;
      while (r < stop && guard++ <= count + 4) {
        var e = doc.byRecord[r];
        if (!e) { r++; continue; }
        r += e.consumed;
        emitEntity(e, m, depth, symName);
      }
    }

    function emitEntity(e, m, depth, symName) {
      var base = {
        pen: e.pen, ltype: e.ltype, level: e.level,
        part: e.part || '', sym: symName || '', rec: e.rec
      };
      var p, q;
      switch (e.kind) {
        case 'line':
          p = apply(m, e.x, e.y);
          q = apply(m, e.x + e.dx, e.y + e.dy);
          if (p[0] === q[0] && p[1] === q[1]) return;   // zero-length
          base.k = 'l'; base.x1 = p[0]; base.y1 = p[1]; base.x2 = q[0]; base.y2 = q[1];
          out.push(base); lines++;
          break;

        case 'arc': {
          if (!(e.rx || e.ry)) return;
          var c = Math.cos(e.rot), s = Math.sin(e.rot);
          // Major/minor axis vectors of the ellipse, then pushed through m.
          var U = applyVec(m, e.rx * c, e.rx * s);
          var V = applyVec(m, -e.ry * s, e.ry * c);
          p = apply(m, e.x, e.y);
          base.k = 'a'; base.cx = p[0]; base.cy = p[1];
          base.ux = U[0]; base.uy = U[1]; base.vx = V[0]; base.vy = V[1];
          base.a1 = e.a1; base.a2 = e.a1 + arcSweep(e.a1, e.a2, e.cw);
          out.push(base); arcs++;
          break;
        }

        case 'bezier': {
          var p0 = apply(m, e.x, e.y);
          var p1 = apply(m, e.x + e.c1x, e.y + e.c1y);
          var p2 = apply(m, e.x + e.c2x, e.y + e.c2y);
          var p3 = apply(m, e.x + e.c3x, e.y + e.c3y);
          base.k = 'b';
          base.p = [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]];
          out.push(base); bez++;
          break;
        }

        case 'rect': {
          if (!e.dx && !e.dy) return;
          var rc = Math.cos(e.rot), rs = Math.sin(e.rot);
          var rm = mul(m, [rc, rs, -rs, rc, e.x, e.y]);
          var cs = rectCorners(e).map(function (c) { return apply(rm, c[0], c[1]); });
          for (var ri = 0; ri < 4; ri++) {
            var A = cs[ri], B = cs[(ri + 1) % 4];
            if (A[0] === B[0] && A[1] === B[1]) continue;
            out.push({
              k: 'l', x1: A[0], y1: A[1], x2: B[0], y2: B[1],
              pen: base.pen, ltype: base.ltype, level: base.level,
              part: base.part, sym: base.sym, rec: base.rec
            });
            lines++;
          }
          break;
        }

        case 'arrow': {
          var ah = (doc.textHeight || 0) * 0.65;
          if (!(ah > 0)) {
            ah = Math.hypot(doc.extents.maxx - doc.extents.minx,
                            doc.extents.maxy - doc.extents.miny) * 0.004;
          }
          if (!(ah > 0)) return;
          arrowBarbs(e.a0, ah).forEach(function (q) {
            var s0 = apply(m, e.x + q[0], e.y + q[1]);
            var s1 = apply(m, e.x + q[2], e.y + q[3]);
            out.push({
              k: 'l', x1: s0[0], y1: s0[1], x2: s1[0], y2: s1[1],
              pen: base.pen, ltype: base.ltype, level: base.level,
              part: base.part, sym: base.sym, rec: base.rec
            });
            dims++;
          });
          break;
        }

        case 'dim': {
          var ds = dimSegments(e);
          if (!ds.length) return;
          var cr = Math.cos(e.rot), sr = Math.sin(e.rot);
          var dm = mul(m, [cr, sr, -sr, cr, e.x, e.y]);
          for (var di = 0; di < ds.length; di++) {
            var s0 = apply(dm, ds[di][0], ds[di][1]);
            var s1 = apply(dm, ds[di][2], ds[di][3]);
            if (s0[0] === s1[0] && s0[1] === s1[1]) continue;
            out.push({
              k: 'l', x1: s0[0], y1: s0[1], x2: s1[0], y2: s1[1],
              pen: base.pen, ltype: base.ltype, level: base.level,
              part: base.part, sym: base.sym, rec: base.rec
            });
            dims++;
          }
          break;
        }

        case 'angdim': {
          var ad = angDimSegments(e);
          if (!ad) return;
          var am = mul(m, [1, 0, 0, 1, e.x, e.y]);
          function attrs() {
            return { pen: base.pen, ltype: base.ltype, level: base.level,
                     part: base.part, sym: base.sym, rec: base.rec };
          }
          ad.lines.forEach(function (q) {
            var s0 = apply(am, q[0], q[1]), s1 = apply(am, q[2], q[3]);
            if (s0[0] === s1[0] && s0[1] === s1[1]) return;
            var o = attrs();
            o.k = 'l'; o.x1 = s0[0]; o.y1 = s0[1]; o.x2 = s1[0]; o.y2 = s1[1];
            out.push(o); dims++;
          });
          ad.arcs.forEach(function (q) {
            var c = apply(am, q[0], q[1]);
            var U = applyVec(am, q[2], 0), V = applyVec(am, 0, q[2]);
            var o = attrs();
            o.k = 'a'; o.cx = c[0]; o.cy = c[1];
            o.ux = U[0]; o.uy = U[1]; o.vx = V[0]; o.vy = V[1];
            o.a1 = q[3]; o.a2 = q[4];
            out.push(o); dims++;
          });
          break;
        }

        case 'text': {
          if (!e.text || !e.h) return;
          p = apply(m, e.x, e.y);
          // Local text axes -> world, so mirrored/rotated symbols carry through.
          var ax = applyVec(m, Math.cos(e.rot), Math.sin(e.rot));
          var ay = applyVec(m, -Math.sin(e.rot), Math.cos(e.rot));
          base.k = 't';
          base.x = p[0]; base.y = p[1];
          base.rot = Math.atan2(ax[1], ax[0]);
          base.w = e.w * TEXT_WIDTH_SCALE * Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1]);
          base.h = e.h * Math.sqrt(ay[0] * ay[0] + ay[1] * ay[1]);
          base.s = e.text;
          base.font = e.font;
          out.push(base); texts++;
          break;
        }

        case 'insert': {
          var sym = doc.symbols[e.symGroup + ' ' + e.symId];
          if (!sym) {
            var key = e.symGroup + '#' + e.symId;
            missing[key] = (missing[key] || 0) + 1;
            return;
          }
          inserts++;
          var cr = Math.cos(e.rot), sr = Math.sin(e.rot);
          // world = T(insert) . R(rot) . S(sx, sy)
          //
          // The symbol body's own origin goes to the insertion point; the base
          // point in the symbol table is a reference mark inside the body (it
          // coincides with the first entity), not the origin to place from.
          // Subtracting it drags every placement off by the base offset.
          var local = mul([cr, sr, -sr, cr, e.x, e.y], [e.sx, 0, 0, e.sy, 0, 0]);
          emitRange(sym.start, sym.count, mul(m, local), depth + 1,
                    sym.group + '/' + sym.name);
          break;
        }
        default:
          break;
      }
    }

    var ents = doc.entities;
    for (var i = 0; i < ents.length; i++) emitEntity(ents[i], IDENT, 0, '');

    return {
      prims: out,
      counts: { lines: lines, arcs: arcs, beziers: bez, texts: texts,
                inserts: inserts, dimensions: dims },
      missingSymbols: missing
    };
  }

  /** Bounding box of a display list. Returns null when there is nothing to draw. */
  function bounds(prims) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, n = 0;
    function add(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      n++;
    }
    for (var i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.k === 'l') { add(p.x1, p.y1); add(p.x2, p.y2); }
      else if (p.k === 'a') {
        // Exact extent of the swept part of C + U cos t + V sin t: the two
        // endpoints, plus any stationary point of x or y inside the sweep.
        // Using the whole ellipse instead would be wildly generous for a long
        // radius with a short sweep, and zoom-to-fit would show mostly blank.
        var lo = Math.min(p.a1, p.a2), hi = Math.max(p.a1, p.a2);
        var atT = function (t) {
          add(p.cx + p.ux * Math.cos(t) + p.vx * Math.sin(t),
              p.cy + p.uy * Math.cos(t) + p.vy * Math.sin(t));
        };
        atT(p.a1); atT(p.a2);
        var cand = [Math.atan2(p.vx, p.ux), Math.atan2(p.vy, p.uy)];
        for (var c = 0; c < 2; c++) {
          var t0 = cand[c] + Math.PI * Math.ceil((lo - cand[c]) / Math.PI);
          for (var t = t0, guard = 0; t <= hi + 1e-12 && guard < 8; t += Math.PI, guard++) {
            atT(t);
          }
        }
      } else if (p.k === 'b') {
        for (var j = 0; j < 8; j += 2) add(p.p[j], p.p[j + 1]);
      } else if (p.k === 't') {
        var w = p.s.length * p.w, h = p.h;
        var c = Math.cos(p.rot), s = Math.sin(p.rot);
        add(p.x, p.y);
        add(p.x + w * c, p.y + w * s);
        add(p.x - h * s, p.y + h * c);
        add(p.x + w * c - h * s, p.y + w * s + h * c);
      }
    }
    if (!n || !isFinite(minx)) return null;
    return { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
  }

  /**
   * Tessellate a primitive into a flat [x0,y0,x1,y1,...] point list.
   * `scale` is world units -> pixels, used to pick a segment count.
   */
  function tessellate(p, scale) {
    var pts, i, n, t;
    if (p.k === 'l') return [p.x1, p.y1, p.x2, p.y2];
    if (p.k === 'a') {
      var rmax = Math.max(Math.hypot(p.ux, p.uy), Math.hypot(p.vx, p.vy)) * scale;
      var sweep = p.a2 - p.a1;
      // Keep the sagitta under ~0.3 px.
      var step = rmax > 0.6 ? 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.3 / rmax))) : Math.PI / 2;
      n = Math.max(2, Math.min(4096, Math.ceil(Math.abs(sweep) / step)));
      pts = new Array((n + 1) * 2);
      for (i = 0; i <= n; i++) {
        t = p.a1 + sweep * (i / n);
        var ct = Math.cos(t), st = Math.sin(t);
        pts[i * 2] = p.cx + p.ux * ct + p.vx * st;
        pts[i * 2 + 1] = p.cy + p.uy * ct + p.vy * st;
      }
      return pts;
    }
    if (p.k === 'b') {
      var q = p.p;
      var d = Math.hypot(q[2] - q[0], q[3] - q[1]) + Math.hypot(q[4] - q[2], q[5] - q[3])
            + Math.hypot(q[6] - q[4], q[7] - q[5]);
      n = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(d * scale * 0.6))));
      pts = new Array((n + 1) * 2);
      for (i = 0; i <= n; i++) {
        t = i / n;
        var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c2 = 3 * u * t * t, dd = t * t * t;
        pts[i * 2] = a * q[0] + b * q[2] + c2 * q[4] + dd * q[6];
        pts[i * 2 + 1] = a * q[1] + b * q[3] + c2 * q[5] + dd * q[7];
      }
      return pts;
    }
    return null;
  }

  global.VCAD = global.VCAD || {};
  global.VCAD.flatten = flatten;
  global.VCAD.bounds = bounds;
  global.VCAD.tessellate = tessellate;
  global.VCAD.mat = { mul: mul, apply: apply, applyVec: applyVec, IDENT: IDENT };
  global.VCAD.arcSweep = arcSweep;
  global.VCAD.TEXT_WIDTH_SCALE = TEXT_WIDTH_SCALE;
  global.VCAD.dimSegments = dimSegments;
  global.VCAD.rectCorners = rectCorners;
  global.VCAD.arrowBarbs = arrowBarbs;
  global.VCAD.angDimSegments = angDimSegments;
  global.VCAD.isFullTurn = isFullTurn;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/vcad-style.js ==== */
/*
 * vcad-style.js - pen colours and line-type patterns.
 *
 * VersaCAD stores a pen number (byte 0x05) and a line-type number (byte 0x07)
 * per entity. The pen->colour mapping and the exact dash patterns lived in the
 * application's configuration, not in the drawing file, so the tables below are
 * conventional CAD equivalents chosen to read well on screen and to survive a
 * round trip through DXF. Dash lengths are in drawing units and get scaled by
 * the drawing size (see ltScale) so they look sane whatever the file's units.
 */
(function (global) {
  'use strict';

  // Pen 0 is unused in practice; index = pen number.
  var PEN_COLORS = [
    '#000000', // 0 - treated as default
    '#000000', // 1
    '#c02020', // 2
    '#1060c0', // 3
    '#0e8a3a', // 4
    '#b26a00', // 5
    '#8a2fbe', // 6
    '#0f8f96', // 7
    '#7a5230', // 8
    '#606060', '#606060', '#606060', '#606060', '#606060', '#606060', '#606060'
  ];

  // Lighter equivalents for a dark drawing sheet, where the near-black pen 1
  // and the deeper blues would otherwise disappear into the background.
  var PEN_COLORS_DARK = [
    '#e8ecf1',
    '#e8ecf1', // 1
    '#ff7b72', // 2
    '#58a6ff', // 3
    '#56d364', // 4
    '#e3a008', // 5
    '#c68cff', // 6
    '#39d3d3', // 7
    '#d0a878', // 8
    '#a0a8b0', '#a0a8b0', '#a0a8b0', '#a0a8b0', '#a0a8b0', '#a0a8b0', '#a0a8b0'
  ];

  // DXF ACI colour numbers matching the palette above, for export.
  var PEN_ACI = [7, 7, 1, 5, 3, 30, 6, 4, 34, 8, 8, 8, 8, 8, 8, 8];

  // name + dash pattern (draw, gap, draw, gap, ...) in nominal units.
  var LTYPES = {
    1: { name: 'CONTINUOUS', desc: 'Solid line', dash: [] },
    2: { name: 'HIDDEN', desc: 'Hidden __ __ __ __', dash: [0.25, 0.125] },
    3: { name: 'DOTTED', desc: 'Dotted . . . . . .', dash: [0.02, 0.12] },
    4: { name: 'CENTER', desc: 'Center ____ _ ____ _', dash: [0.6, 0.12, 0.12, 0.12] },
    5: { name: 'PHANTOM', desc: 'Phantom ____ _ _ ____', dash: [0.7, 0.12, 0.12, 0.12, 0.12, 0.12] },
    6: { name: 'DASHDOT', desc: 'Dash dot __ . __ . __', dash: [0.35, 0.12, 0.02, 0.12] },
    7: { name: 'DASHED2', desc: 'Long dash ____ ____', dash: [0.6, 0.18] },
    8: { name: 'DASHED3', desc: 'Short dash _ _ _ _ _', dash: [0.12, 0.09] }
  };

  /** `dark` means the drawing sheet itself is dark, not the page chrome. */
  function penColor(pen, mono, dark) {
    if (mono) return dark ? '#eaeef3' : '#000000';
    var t = dark ? PEN_COLORS_DARK : PEN_COLORS;
    return t[pen] || t[0];
  }

  function ltype(n) { return LTYPES[n] || LTYPES[1]; }

  /**
   * Dash patterns are authored for a drawing roughly 400 units across.
   * Scale them so a small (or huge) drawing still shows recognisable dashes.
   */
  function ltScale(bbox) {
    if (!bbox) return 1;
    var d = Math.hypot(bbox.maxx - bbox.minx, bbox.maxy - bbox.miny);
    if (!isFinite(d) || d <= 0) return 1;
    return d / 480;
  }

  global.VCAD = global.VCAD || {};
  global.VCAD.style = {
    PEN_COLORS: PEN_COLORS, PEN_COLORS_DARK: PEN_COLORS_DARK,
    PEN_ACI: PEN_ACI, LTYPES: LTYPES,
    penColor: penColor, ltype: ltype, ltScale: ltScale
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/vcad-render.js ==== */
/*
 * vcad-render.js - canvas view of a flattened VersaCAD drawing.
 *
 * Geometry is built into Path2D objects in *world* coordinates and drawn
 * through a canvas transform, so panning and zooming cost almost nothing.
 * Paths are rebuilt only when the zoom changes enough that curve tessellation
 * would show facets.
 */
(function (global) {
  'use strict';

  var VCAD = global.VCAD = global.VCAD || {};

  function Viewer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.prims = [];
    this.bbox = null;
    this.view = { scale: 1, cx: 0, cy: 0 };   // world point at canvas centre
    this.opts = {
      mono: false, showText: true, showLineTypes: true, dark: false,
      ltScale: 1, lineWidth: 1, background: '#ffffff'
    };
    this.visible = null;      // optional predicate(prim) -> boolean
    this._cache = null;
    this._cacheScale = 0;
    this._raf = 0;
    this._dpr = 1;
  }

  Viewer.prototype.setDrawing = function (prims, bbox) {
    this.prims = prims || [];
    this.bbox = bbox;
    this._cache = null;
    this.opts.ltScale = VCAD.style.ltScale(bbox);
    this.fit();
  };

  Viewer.prototype.invalidate = function () {
    this._cache = null;
    this.draw();
  };

  Viewer.prototype.resize = function () {
    var c = this.canvas;
    var dpr = global.devicePixelRatio || 1;
    var w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this._dpr = dpr;
    this.draw();
  };

  Viewer.prototype.fit = function (margin) {
    var b = this.bbox;
    if (!b) return;
    margin = margin == null ? 0.04 : margin;
    var w = Math.max(1e-9, b.maxx - b.minx), h = Math.max(1e-9, b.maxy - b.miny);
    var cw = Math.max(1, this.canvas.clientWidth), ch = Math.max(1, this.canvas.clientHeight);
    this.view.scale = Math.min(cw / w, ch / h) * (1 - margin * 2);
    this.view.cx = (b.minx + b.maxx) / 2;
    this.view.cy = (b.miny + b.maxy) / 2;
    this.draw();
  };

  Viewer.prototype.zoomAt = function (px, py, factor) {
    var before = this.toWorld(px, py);
    this.view.scale = Math.max(1e-9, Math.min(1e9, this.view.scale * factor));
    var after = this.toWorld(px, py);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.draw();
  };

  Viewer.prototype.pan = function (dxPx, dyPx) {
    this.view.cx -= dxPx / this.view.scale;
    this.view.cy += dyPx / this.view.scale;
    this.draw();
  };

  Viewer.prototype.toWorld = function (px, py) {
    var cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    return {
      x: this.view.cx + (px - cw / 2) / this.view.scale,
      y: this.view.cy - (py - ch / 2) / this.view.scale
    };
  };

  Viewer.prototype.toScreen = function (x, y) {
    var cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    return {
      x: (x - this.view.cx) * this.view.scale + cw / 2,
      y: ch / 2 - (y - this.view.cy) * this.view.scale
    };
  };

  /** Zoom to a rectangle given in screen pixels. */
  Viewer.prototype.zoomToRect = function (x0, y0, x1, y1) {
    var a = this.toWorld(Math.min(x0, x1), Math.max(y0, y1));
    var b = this.toWorld(Math.max(x0, x1), Math.min(y0, y1));
    var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 1e-9 || h < 1e-9) return;
    var cw = Math.max(1, this.canvas.clientWidth), ch = Math.max(1, this.canvas.clientHeight);
    this.view.scale = Math.min(cw / w, ch / h) * 0.96;
    this.view.cx = (a.x + b.x) / 2;
    this.view.cy = (a.y + b.y) / 2;
    this.draw();
  };

  Viewer.prototype._build = function () {
    var st = VCAD.style;
    var groups = {}, order = [];
    var scale = this.view.scale;
    var vis = this.visible;
    for (var i = 0; i < this.prims.length; i++) {
      var p = this.prims[i];
      if (p.k === 't') continue;
      if (vis && !vis(p)) continue;
      var key = p.pen + '|' + p.ltype;
      var g = groups[key];
      if (!g) {
        g = groups[key] = { pen: p.pen, ltype: p.ltype, path: new Path2D() };
        order.push(g);
      }
      if (p.k === 'l') {
        g.path.moveTo(p.x1, p.y1);
        g.path.lineTo(p.x2, p.y2);
      } else if (p.k === 'b') {
        g.path.moveTo(p.p[0], p.p[1]);
        g.path.bezierCurveTo(p.p[2], p.p[3], p.p[4], p.p[5], p.p[6], p.p[7]);
      } else if (p.k === 'a') {
        var pts = VCAD.tessellate(p, scale);
        g.path.moveTo(pts[0], pts[1]);
        for (var j = 2; j < pts.length; j += 2) g.path.lineTo(pts[j], pts[j + 1]);
      }
    }
    this._cache = order;
    this._cacheScale = scale;
  };

  Viewer.prototype.draw = function () {
    if (this._raf) return;
    var self = this;
    this._raf = global.requestAnimationFrame(function () {
      self._raf = 0;
      self._paint();
    });
  };

  Viewer.prototype._paint = function () {
    var ctx = this.ctx, st = VCAD.style;
    var dpr = this._dpr, cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.opts.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.prims.length) return;

    var s = this.view.scale;
    // Rebuild tessellation when the zoom has drifted far from the cached level.
    if (!this._cache || s > this._cacheScale * 2.5 || s < this._cacheScale / 2.5) {
      this._build();
    }

    // world -> device pixels, with Y flipped
    var k = s * dpr;
    var tx = (cw / 2 - this.view.cx * s) * dpr;
    var ty = (ch / 2 + this.view.cy * s) * dpr;
    ctx.setTransform(k, 0, 0, -k, tx, ty);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var lw = this.opts.lineWidth * dpr / k;
    ctx.lineWidth = lw;

    for (var i = 0; i < this._cache.length; i++) {
      var g = this._cache[i];
      ctx.strokeStyle = st.penColor(g.pen, this.opts.mono, this.opts.dark);
      var lt = st.ltype(g.ltype);
      if (this.opts.showLineTypes && lt.dash.length) {
        var ls = this.opts.ltScale;
        ctx.setLineDash(lt.dash.map(function (v) { return v * ls; }));
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke(g.path);
    }
    ctx.setLineDash([]);

    if (this.opts.showText) this._paintText();
  };

  var FONT = 'ui-monospace, "DejaVu Sans Mono", "Courier New", monospace';

  /**
   * Cap height as a fraction of the font size, measured once for whatever
   * monospace face the browser actually resolves. VersaCAD's text height is a
   * cap height, so this is what converts it into a font size.
   */
  Viewer.prototype._capRatio = function () {
    if (this._cap) return this._cap;
    var ctx = this.ctx;
    ctx.save();
    ctx.font = '100px ' + FONT;
    var m = ctx.measureText('H');
    ctx.restore();
    var a = m && m.actualBoundingBoxAscent;
    this._cap = (a && a > 20 && a < 100) ? a / 100 : 0.72;
    return this._cap;
  };

  Viewer.prototype._paintText = function () {
    var ctx = this.ctx, st = VCAD.style;
    var dpr = this._dpr, s = this.view.scale, vis = this.visible;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'alphabetic';

    var cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    var cap = this._capRatio();
    var lastSize = -1, adv = 1;

    for (var i = 0; i < this.prims.length; i++) {
      var p = this.prims[i];
      if (p.k !== 't' || !p.s) continue;
      if (vis && !vis(p)) continue;
      var hpx = p.h * s;
      if (hpx < 3.2) continue;                       // too small to read
      var sc = this.toScreen(p.x, p.y);
      var wpx = p.s.length * p.w * s;
      // cheap reject: bounding circle outside the viewport
      var rad = Math.abs(wpx) + Math.abs(hpx);
      if (sc.x < -rad || sc.x > cw + rad || sc.y < -rad || sc.y > ch + rad) continue;

      // Monospace matches VersaCAD's fixed per-character advance.
      var size = Math.round(hpx / cap * 100) / 100;
      if (size !== lastSize) {
        ctx.font = size + 'px ' + FONT;
        adv = ctx.measureText('MMMMMMMMMM').width / 10 || size * 0.6;
        lastSize = size;
      }
      var hs = adv > 0 ? (p.w * s) / adv : 1;
      ctx.save();
      ctx.translate(sc.x, sc.y);
      ctx.rotate(-p.rot);
      ctx.scale(hs, 1);
      ctx.fillStyle = st.penColor(p.pen, this.opts.mono, this.opts.dark);
      ctx.fillText(p.s, 0, 0);
      ctx.restore();
    }
  };

  VCAD.Viewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/vcad-export.js ==== */
/*
 * vcad-export.js - convert a parsed VersaCAD drawing to DXF, SVG or PDF.
 *
 * DXF is written as R12 (AC1009), the most widely readable flavour. Symbols
 * become BLOCK/INSERT pairs so the drawing keeps its structure; elliptical
 * arcs and beziers are flattened to polylines because R12 has no ELLIPSE or
 * SPLINE entity.
 */
(function (global) {
  'use strict';

  var VCAD = global.VCAD = global.VCAD || {};

  // ------------------------------------------------------------------ utils

  function num(v) {
    if (!isFinite(v)) return '0.0';
    var s = v.toFixed(8);
    // trim trailing zeros but keep a decimal point
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
    return s === '-0.0' ? '0.0' : s;
  }

  /** DXF R12 names: uppercase, and none of  <>/\":;?*|=' */
  function dxfName(s, fallback) {
    s = String(s || '').toUpperCase().replace(/[<>/\\":;?*|=',\s]/g, '_');
    s = s.replace(/[^A-Z0-9_$.\-]/g, '_').replace(/^[.\-]/, '_');
    return s || fallback;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------------- DXF

  // DXF's default text style advances about 0.6 em per character; VersaCAD
  // stores an absolute per-character advance, so convert between the two.
  var DXF_CHAR_ADVANCE = 0.6;

  function DxfWriter() { this.buf = []; }
  DxfWriter.prototype.g = function (code, val) { this.buf.push(code, val); return this; };
  DxfWriter.prototype.toString = function () { return this.buf.join('\r\n') + '\r\n'; };

  /**
   * Emit the entities of one record range (a symbol body, or the main drawing)
   * into the writer. Geometry stays in the drawing's own coordinates; blocks
   * carry a base point so INSERT lines up.
   */
  function writeEntities(w, doc, list, layerOf, opts) {
    var st = VCAD.style;
    var layer, color, lt;
    function head(type) {
      w.g(0, type).g(8, layer).g(62, String(color)).g(6, lt);
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      layer = layerOf(e);
      color = st.PEN_ACI[e.pen] || 7;
      lt = st.ltype(e.ltype).name;

      switch (e.kind) {
        case 'line':
          head('LINE');
          w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0');
          w.g(11, num(e.x + e.dx)).g(21, num(e.y + e.dy)).g(31, '0.0');
          break;

        case 'rect': {
          if (!e.dx && !e.dy) break;
          var rc = Math.cos(e.rot), rs = Math.sin(e.rot);
          var pts = [];
          VCAD.rectCorners(e).forEach(function (c) {
            pts.push(e.x + c[0] * rc - c[1] * rs, e.y + c[0] * rs + c[1] * rc);
          });
          polyline(w, pts, layer, color, lt, true);
          break;
        }

        case 'arc': {
          var full = VCAD.isFullTurn(e.a1, e.a2);
          var sweep = VCAD.arcSweep(e.a1, e.a2, e.cw);
          var circular = Math.abs(Math.abs(e.rx) - Math.abs(e.ry)) < 1e-9;
          if (circular && Math.abs(e.rx) > 0) {
            var r = Math.abs(e.rx);
            // DXF always measures an ARC counter-clockwise from group 50 to 51,
            // so a clockwise sweep is written as the same arc the other way up.
            // A rotated circle is still a circle; fold the rotation in.
            var from = e.a1, to = e.a1 + sweep;
            if (sweep < 0) { var sw = from; from = to; to = sw; }
            var a1 = (from + e.rot) * 180 / Math.PI;
            var a2 = (to + e.rot) * 180 / Math.PI;
            if (full) {
              head('CIRCLE');
              w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0').g(40, num(r));
            } else {
              head('ARC');
              w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0').g(40, num(r));
              w.g(50, num(a1)).g(51, num(a2));
            }
          } else {
            // Elliptical: flatten (R12 has no ELLIPSE entity).
            var prim = {
              k: 'a', cx: e.x, cy: e.y,
              ux: e.rx * Math.cos(e.rot), uy: e.rx * Math.sin(e.rot),
              vx: -e.ry * Math.sin(e.rot), vy: e.ry * Math.cos(e.rot),
              a1: e.a1, a2: e.a1 + sweep
            };
            polyline(w, VCAD.tessellate(prim, opts.flatScale), layer, color, lt, full);
          }
          break;
        }

        case 'bezier': {
          var b = {
            k: 'b',
            p: [e.x, e.y, e.x + e.c1x, e.y + e.c1y,
                e.x + e.c2x, e.y + e.c2y, e.x + e.c3x, e.y + e.c3y]
          };
          polyline(w, VCAD.tessellate(b, opts.flatScale), layer, color, lt, false);
          break;
        }

        case 'arrow': {
          var ah = (doc.textHeight || 0) * 0.65;
          if (!(ah > 0)) {
            ah = Math.hypot(doc.extents.maxx - doc.extents.minx,
                            doc.extents.maxy - doc.extents.miny) * 0.004;
          }
          if (!(ah > 0)) break;
          VCAD.arrowBarbs(e.a0, ah).forEach(function (q) {
            head('LINE');
            w.g(10, num(e.x + q[0])).g(20, num(e.y + q[1])).g(30, '0.0');
            w.g(11, num(e.x + q[2])).g(21, num(e.y + q[3])).g(31, '0.0');
          });
          break;
        }

        case 'dim': {
          // Exploded into plain lines. A real DXF DIMENSION would need a
          // dimension style table and an anonymous block; the label is already
          // present as its own TEXT entity either way.
          var ds = VCAD.dimSegments(e);
          var dc = Math.cos(e.rot), dsn = Math.sin(e.rot);
          for (var k = 0; k < ds.length; k++) {
            var q = ds[k];
            head('LINE');
            w.g(10, num(e.x + q[0] * dc - q[1] * dsn))
             .g(20, num(e.y + q[0] * dsn + q[1] * dc)).g(30, '0.0');
            w.g(11, num(e.x + q[2] * dc - q[3] * dsn))
             .g(21, num(e.y + q[2] * dsn + q[3] * dc)).g(31, '0.0');
          }
          break;
        }

        case 'angdim': {
          var ad = VCAD.angDimSegments(e);
          if (!ad) break;
          ad.lines.forEach(function (q) {
            head('LINE');
            w.g(10, num(e.x + q[0])).g(20, num(e.y + q[1])).g(30, '0.0');
            w.g(11, num(e.x + q[2])).g(21, num(e.y + q[3])).g(31, '0.0');
          });
          ad.arcs.forEach(function (q) {
            // DXF measures an ARC counter-clockwise from group 50 to 51.
            var f = q[3], t = q[4];
            if (t < f) { var sw2 = f; f = t; t = sw2; }
            head('ARC');
            w.g(10, num(e.x + q[0])).g(20, num(e.y + q[1])).g(30, '0.0').g(40, num(q[2]));
            w.g(50, num(f * 180 / Math.PI)).g(51, num(t * 180 / Math.PI));
          });
          break;
        }

        case 'text': {
          if (!e.text) break;
          head('TEXT');
          w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0');
          w.g(40, num(e.h));
          w.g(1, e.text);
          if (e.rot) w.g(50, num(e.rot * 180 / Math.PI));
          var adv = e.w * VCAD.TEXT_WIDTH_SCALE;
          var wf = e.h > 0 ? adv / (DXF_CHAR_ADVANCE * e.h) : 1;
          if (!isFinite(wf) || wf <= 0) wf = 1;
          w.g(41, num(Math.max(0.05, Math.min(20, wf))));
          break;
        }

        case 'insert': {
          var sym = doc.symbols[e.symGroup + ' ' + e.symId];
          if (!sym) break;
          head('INSERT');
          w.g(2, blockName(sym));
          w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0');
          w.g(41, num(e.sx)).g(42, num(e.sy)).g(43, '1.0');
          if (e.rot) w.g(50, num(e.rot * 180 / Math.PI));
          break;
        }
        default: break;
      }
    }
  }

  function polyline(w, pts, layer, color, lt, closed) {
    if (!pts || pts.length < 4) return;
    // A closed polyline gets its final segment from the closing flag, so the
    // duplicated last vertex the tessellator emits would be redundant.
    var n = pts.length;
    if (closed && n >= 6 &&
        Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) {
      n -= 2;
    }
    w.g(0, 'POLYLINE').g(8, layer).g(62, String(color)).g(6, lt)
     .g(66, '1').g(70, closed ? '1' : '0')
     .g(10, '0.0').g(20, '0.0').g(30, '0.0');
    for (var i = 0; i < n; i += 2) {
      w.g(0, 'VERTEX').g(8, layer)
       .g(10, num(pts[i])).g(20, num(pts[i + 1])).g(30, '0.0');
    }
    w.g(0, 'SEQEND').g(8, layer);
  }

  var blockNames = null;
  function blockName(sym) {
    return blockNames ? blockNames[sym.group + ' ' + sym.index] : 'BLK';
  }

  function toDXF(doc, userOpts) {
    var st = VCAD.style;
    var opts = {};
    for (var key in (userOpts || {})) opts[key] = userOpts[key];
    var bbox = opts.bbox || doc.extents;
    // Curve flattening resolution, expressed as if the drawing were 400 units.
    opts.flatScale = opts.flatScale || (400 / Math.max(1e-6,
      Math.hypot((bbox.maxx - bbox.minx) || 1, (bbox.maxy - bbox.miny) || 1)));

    // ---- collect layers -------------------------------------------------
    var layerSet = { '0': true };
    function layerOf(e) {
      var n = dxfName(e.part, '0');
      layerSet[n] = true;
      return n;
    }

    // ---- name the blocks, uniquely -------------------------------------
    blockNames = {};
    var used = {};
    doc.symbolList.forEach(function (s) {
      var base = dxfName((s.group ? s.group + '_' : '') + s.name, 'SYM');
      var n = base, k = 1;
      while (used[n]) n = base + '_' + (k++);
      used[n] = true;
      blockNames[s.group + ' ' + s.index] = n;
    });

    // Gather entities per symbol (walking the record range like the renderer).
    var blocks = doc.symbolList.map(function (s) {
      var list = [], r = s.start, stop = s.start + s.count, guard = 0;
      while (r < stop && guard++ <= s.count + 4) {
        var e = doc.byRecord[r];
        if (!e) { r++; continue; }
        r += e.consumed;
        list.push(e);
        layerOf(e);
      }
      return { sym: s, list: list };
    });
    doc.entities.forEach(layerOf);

    // ---- line types actually used --------------------------------------
    var ltSet = { CONTINUOUS: true };
    function scanLt(list) {
      list.forEach(function (e) { ltSet[st.ltype(e.ltype).name] = true; });
    }
    scanLt(doc.entities);
    blocks.forEach(function (b) { scanLt(b.list); });

    var ltScale = st.ltScale(bbox);
    var w = new DxfWriter();

    // ---- HEADER ---------------------------------------------------------
    w.g(0, 'SECTION').g(2, 'HEADER');
    w.g(9, '$ACADVER').g(1, 'AC1009');
    w.g(9, '$EXTMIN').g(10, num(bbox.minx)).g(20, num(bbox.miny)).g(30, '0.0');
    w.g(9, '$EXTMAX').g(10, num(bbox.maxx)).g(20, num(bbox.maxy)).g(30, '0.0');
    w.g(9, '$LTSCALE').g(40, num(ltScale));
    w.g(9, '$TEXTSTYLE').g(7, 'STANDARD');
    w.g(0, 'ENDSEC');

    // ---- TABLES ---------------------------------------------------------
    w.g(0, 'SECTION').g(2, 'TABLES');

    var ltNames = Object.keys(ltSet);
    w.g(0, 'TABLE').g(2, 'LTYPE').g(70, String(ltNames.length));
    ltNames.forEach(function (name) {
      var def = null;
      for (var k in st.LTYPES) if (st.LTYPES[k].name === name) def = st.LTYPES[k];
      var dash = (def && def.dash.length) ? def.dash : null;
      w.g(0, 'LTYPE').g(2, name).g(70, '0')
       .g(3, def ? def.desc : 'Solid line').g(72, '65');
      if (!dash) {
        w.g(73, '0').g(40, '0.0');
      } else {
        var total = 0, i;
        for (i = 0; i < dash.length; i++) total += dash[i];
        w.g(73, String(dash.length)).g(40, num(total));
        for (i = 0; i < dash.length; i++) {
          w.g(49, num(i % 2 === 0 ? dash[i] : -dash[i]));
        }
      }
    });
    w.g(0, 'ENDTAB');

    var layers = Object.keys(layerSet);
    w.g(0, 'TABLE').g(2, 'LAYER').g(70, String(layers.length));
    layers.forEach(function (n) {
      w.g(0, 'LAYER').g(2, n).g(70, '0').g(62, '7').g(6, 'CONTINUOUS');
    });
    w.g(0, 'ENDTAB');

    w.g(0, 'TABLE').g(2, 'STYLE').g(70, '1');
    w.g(0, 'STYLE').g(2, 'STANDARD').g(70, '0').g(40, '0.0').g(41, '1.0')
     .g(50, '0.0').g(71, '0').g(42, '0.2').g(3, 'txt').g(4, '');
    w.g(0, 'ENDTAB');
    w.g(0, 'ENDSEC');

    // ---- BLOCKS ---------------------------------------------------------
    w.g(0, 'SECTION').g(2, 'BLOCKS');
    blocks.forEach(function (b) {
      var n = blockName(b.sym);
      w.g(0, 'BLOCK').g(8, '0').g(2, n).g(70, '0')
       // Block base point is the body's own origin, matching how VersaCAD
       // places a symbol; INSERT then needs no compensating offset.
       .g(10, '0.0').g(20, '0.0').g(30, '0.0').g(3, n);
      writeEntities(w, doc, b.list, layerOf, opts);
      w.g(0, 'ENDBLK').g(8, '0');
    });
    w.g(0, 'ENDSEC');

    // ---- ENTITIES -------------------------------------------------------
    w.g(0, 'SECTION').g(2, 'ENTITIES');
    writeEntities(w, doc, doc.entities.filter(function (e) {
      return !opts.filter || opts.filter(e);
    }), layerOf, opts);
    w.g(0, 'ENDSEC');
    w.g(0, 'EOF');

    blockNames = null;
    return w.toString();
  }

  // ------------------------------------------------------------------- SVG

  function toSVG(prims, bbox, opts) {
    opts = opts || {};
    var st = VCAD.style;
    var pad = (Math.hypot(bbox.maxx - bbox.minx, bbox.maxy - bbox.miny) || 1) * 0.01;
    var x0 = bbox.minx - pad, y0 = bbox.miny - pad;
    var W = (bbox.maxx - bbox.minx) + 2 * pad, H = (bbox.maxy - bbox.miny) + 2 * pad;
    var lw = opts.lineWidth || Math.max(W, H) / 2400;
    var lts = st.ltScale(bbox);
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      num(W) + ' ' + num(H) + '" width="' + Math.round(Math.min(4000, W * 4)) +
      '" height="' + Math.round(Math.min(4000, H * 4)) + '">');
    out.push('<rect width="100%" height="100%" fill="' + (opts.background || '#ffffff') + '"/>');
    // Flip Y: SVG grows downward, CAD grows upward.
    out.push('<g transform="translate(0,' + num(H) + ') scale(1,-1) translate(' +
      num(-x0) + ',' + num(-y0) + ')" fill="none" stroke-width="' + num(lw) +
      '" stroke-linecap="round">');

    var groups = {};
    function key(p) { return p.pen + '|' + p.ltype; }
    for (var i = 0; i < prims.length; i++) {
      if (prims[i].k === 't') continue;
      (groups[key(prims[i])] = groups[key(prims[i])] || []).push(prims[i]);
    }

    Object.keys(groups).forEach(function (k) {
      var g = groups[k], p0 = g[0];
      var col = st.penColor(p0.pen, opts.mono, opts.dark);
      var lt = st.ltype(p0.ltype);
      var da = lt.dash.length
        ? ' stroke-dasharray="' + lt.dash.map(function (v) { return num(v * lts); }).join(' ') + '"'
        : '';
      var d = [];
      for (var i = 0; i < g.length; i++) {
        var p = g[i];
        if (p.k === 'l') {
          d.push('M' + num(p.x1) + ' ' + num(p.y1) + 'L' + num(p.x2) + ' ' + num(p.y2));
        } else if (p.k === 'b') {
          d.push('M' + num(p.p[0]) + ' ' + num(p.p[1]) + 'C' + num(p.p[2]) + ' ' + num(p.p[3]) +
            ' ' + num(p.p[4]) + ' ' + num(p.p[5]) + ' ' + num(p.p[6]) + ' ' + num(p.p[7]));
        } else if (p.k === 'a') {
          var pts = VCAD.tessellate(p, 400 / Math.max(W, H) * 40);
          var s = 'M' + num(pts[0]) + ' ' + num(pts[1]);
          for (var j = 2; j < pts.length; j += 2) s += 'L' + num(pts[j]) + ' ' + num(pts[j + 1]);
          d.push(s);
        }
      }
      out.push('<path stroke="' + col + '"' + da + ' d="' + d.join('') + '"/>');
    });

    // Text is drawn in an un-flipped group so glyphs are the right way up.
    var texts = prims.filter(function (p) { return p.k === 't' && p.s; });
    if (texts.length) {
      out.push('</g>');
      out.push('<g transform="translate(' + num(-x0) + ',' + num(H + y0) + ')" ' +
        'font-family="monospace" stroke="none">');
      texts.forEach(function (p) {
        var col = st.penColor(p.pen, opts.mono, opts.dark);
        var deg = -p.rot * 180 / Math.PI;
        out.push('<text x="0" y="0" fill="' + col + '" font-size="' + num(p.h * 1.32) +
          '" textLength="' + num(p.s.length * p.w) + '" lengthAdjust="spacingAndGlyphs"' +
          ' transform="translate(' + num(p.x) + ',' + num(-p.y) + ') rotate(' + num(deg) + ')">' +
          esc(p.s) + '</text>');
      });
      out.push('</g>');
    } else {
      out.push('</g>');
    }
    out.push('</svg>');
    return out.join('\n');
  }

  // ------------------------------------------------------------------- PDF

  // Courier is metrically simple: every glyph advances 600/1000 em and its
  // cap height is 562/1000 em. VersaCAD's fixed per-character advance maps
  // onto it cleanly.
  var COURIER_ADV = 0.6, COURIER_CAP = 0.562;

  function pdfEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7e]/g, '?');
  }

  function toPDF(prims, bbox, opts) {
    opts = opts || {};
    var st = VCAD.style;
    var margin = opts.margin != null ? opts.margin : 18;   // points
    var pw = opts.pageWidth || 842, ph = opts.pageHeight || 595;   // A4 landscape

    var dw = Math.max(1e-9, bbox.maxx - bbox.minx);
    var dh = Math.max(1e-9, bbox.maxy - bbox.miny);
    var s = Math.min((pw - 2 * margin) / dw, (ph - 2 * margin) / dh);
    var ox = margin + ((pw - 2 * margin) - dw * s) / 2 - bbox.minx * s;
    var oy = margin + ((ph - 2 * margin) - dh * s) / 2 - bbox.miny * s;
    function X(v) { return (v * s + ox).toFixed(3); }
    function Y(v) { return (v * s + oy).toFixed(3); }

    var lts = st.ltScale(bbox) * s;
    var body = [];
    if (opts.dark) {
      body.push('0.071 0.082 0.102 rg 0 0 ' + pw + ' ' + ph + ' re f');
    }
    body.push((opts.lineWidth || 0.4).toFixed(2) + ' w 1 J 1 j');

    var curCol = null, curDash = null;
    function setStyle(p) {
      var c = st.penColor(p.pen, opts.mono, opts.dark);
      if (c !== curCol) {
        curCol = c;
        var r = parseInt(c.slice(1, 3), 16) / 255,
            g = parseInt(c.slice(3, 5), 16) / 255,
            b = parseInt(c.slice(5, 7), 16) / 255;
        body.push(r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' RG');
        body.push(r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' rg');
      }
      var lt = st.ltype(p.ltype);
      var d = lt.dash.length
        ? '[' + lt.dash.map(function (v) { return (v * lts).toFixed(2); }).join(' ') + '] 0 d'
        : '[] 0 d';
      if (d !== curDash) { curDash = d; body.push(d); }
    }

    var texts = [];
    for (var i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.k === 't') { if (p.s) texts.push(p); continue; }
      setStyle(p);
      if (p.k === 'l') {
        body.push(X(p.x1) + ' ' + Y(p.y1) + ' m ' + X(p.x2) + ' ' + Y(p.y2) + ' l S');
      } else if (p.k === 'b') {
        var q = p.p;
        body.push(X(q[0]) + ' ' + Y(q[1]) + ' m ' + X(q[2]) + ' ' + Y(q[3]) + ' ' +
          X(q[4]) + ' ' + Y(q[5]) + ' ' + X(q[6]) + ' ' + Y(q[7]) + ' c S');
      } else if (p.k === 'a') {
        var pts = VCAD.tessellate(p, s);
        var seg = X(pts[0]) + ' ' + Y(pts[1]) + ' m';
        for (var j = 2; j < pts.length; j += 2) seg += ' ' + X(pts[j]) + ' ' + Y(pts[j + 1]) + ' l';
        body.push(seg + ' S');
      }
    }

    if (texts.length) {
      body.push('BT');
      var lastFont = null;
      texts.forEach(function (t) {
        var col = st.penColor(t.pen, opts.mono, opts.dark);
        var r = parseInt(col.slice(1, 3), 16) / 255,
            g = parseInt(col.slice(3, 5), 16) / 255,
            b = parseInt(col.slice(5, 7), 16) / 255;
        body.push(r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' rg');
        var size = (t.h * s) / COURIER_CAP;
        if (size <= 0.01) return;
        var tz = 100 * (t.w * s) / (COURIER_ADV * size);
        if (!isFinite(tz) || tz <= 0) tz = 100;
        if (lastFont !== size) { body.push('/F1 ' + size.toFixed(3) + ' Tf'); lastFont = size; }
        body.push(Math.min(9999, tz).toFixed(2) + ' Tz');
        var c = Math.cos(t.rot), sn = Math.sin(t.rot);
        body.push(c.toFixed(6) + ' ' + sn.toFixed(6) + ' ' + (-sn).toFixed(6) + ' ' +
          c.toFixed(6) + ' ' + X(t.x) + ' ' + Y(t.y) + ' Tm');
        body.push('(' + pdfEsc(t.s) + ') Tj');
      });
      body.push('ET');
    }

    var content = body.join('\n');
    var objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph +
      '] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
    objs[4] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
    objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';

    var pdf = '%PDF-1.4\n';
    var offsets = [];
    for (var n = 1; n <= 5; n++) {
      offsets[n] = pdf.length;
      pdf += n + ' 0 obj\n' + objs[n] + '\nendobj\n';
    }
    var xref = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (n = 1; n <= 5; n++) {
      pdf += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    }
    pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return pdf;
  }

  VCAD.exportDXF = toDXF;
  VCAD.exportSVG = toSVG;
  VCAD.exportPDF = toPDF;
  VCAD.dxfName = dxfName;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/app.js ==== */
/* app.js - wiring for the VersaCAD viewer page. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('cv');
  var viewer = new VCAD.Viewer(canvas);

  var docs = [];        // { name, doc, flat, bbox, filters }
  var current = -1;

  // ---------------------------------------------------------------- loading

  function showWarn(msg) {
    var el = $('warn');
    if (!msg) { el.style.display = 'none'; return; }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(showWarn._t);
    showWarn._t = setTimeout(function () { el.style.display = 'none'; }, 7000);
  }

  function loadBuffer(buf, name) {
    var doc = VCAD.parse(buf, name);
    var flat = VCAD.flatten(doc);
    var bbox = VCAD.bounds(flat.prims) || {
      minx: doc.extents.minx, miny: doc.extents.miny,
      maxx: doc.extents.maxx, maxy: doc.extents.maxy
    };
    return {
      name: name, doc: doc, flat: flat, bbox: bbox,
      filters: { part: {}, pen: {}, ltype: {} }
    };
  }

  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var errors = [];
    var pending = files.length;

    files.forEach(function (f) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          docs.push(loadBuffer(fr.result, f.name));
        } catch (err) {
          errors.push(f.name + ': ' + (err && err.message ? err.message : err));
        }
        if (--pending === 0) done();
      };
      fr.onerror = function () {
        errors.push(f.name + ': could not be read');
        if (--pending === 0) done();
      };
      fr.readAsArrayBuffer(f);
    });

    function done() {
      if (errors.length) showWarn(errors.join('  |  '));
      if (docs.length) {
        $('drop').classList.add('hide');
        select(docs.length - 1);
        renderFileList();
      }
    }
  }

  // ---------------------------------------------------------------- side UI

  function renderFileList() {
    var box = $('fileList');
    box.innerHTML = '';
    $('grpFiles').hidden = docs.length < 2;
    docs.forEach(function (d, i) {
      var b = document.createElement('button');
      b.innerHTML = '<span class="nm">' + escapeHtml(d.name) + '</span>' +
                    '<span class="ct">' + d.flat.prims.length + '</span>';
      b.setAttribute('aria-current', i === current ? 'true' : 'false');
      b.onclick = function () { select(i); renderFileList(); };
      box.appendChild(b);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function row(k, v) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v">' +
      escapeHtml(v) + '</span></div>';
  }

  function fmt(n, d) { return Number(n).toFixed(d == null ? 2 : d); }

  function renderInfo(d) {
    var s = d.doc.sections, c = d.flat.counts, b = d.bbox;
    var html = '';
    html += row('File', d.name);
    html += row('VersaCAD version', d.doc.versionName);
    html += row('Records', s.total);
    html += row('Entities', d.doc.entities.length);
    html += row('Symbols', d.doc.symbolList.length);
    html += row('Lines', c.lines);
    html += row('Arcs', c.arcs);
    if (c.beziers) html += row('Curves', c.beziers);
    html += row('Text', c.texts);
    if (c.inserts) html += row('Symbol placements', c.inserts);
    html += row('Extents X', fmt(b.minx) + ' … ' + fmt(b.maxx));
    html += row('Extents Y', fmt(b.miny) + ' … ' + fmt(b.maxy));
    html += row('Size', fmt(b.maxx - b.minx) + ' × ' + fmt(b.maxy - b.miny));
    var miss = Object.keys(d.flat.missingSymbols);
    if (miss.length) html += row('Unresolved symbols', miss.join(', '));

    // Anything the reader could not identify, so a drawing that is quietly
    // missing something says so instead of just looking wrong.
    var unk = {}, unkTotal = 0;
    for (var rk in d.doc.byRecord) {
      var ue = d.doc.byRecord[rk];
      if (ue.kind !== 'other') continue;
      unk[ue.type] = (unk[ue.type] || 0) + 1;
      unkTotal++;
    }
    if (unkTotal) {
      html += row('Not drawn', Object.keys(unk).sort(function (a, b) { return a - b; })
        .map(function (t) { return unk[t] + ' × type ' + t; }).join(', '));
    }
    if (d.doc.warnings.length) {
      html += row('Skipped records', String(d.doc.warnings.length));
    }
    $('info').innerHTML = html;
    $('grpInfo').hidden = false;
  }

  function tally(prims, key) {
    var m = {};
    for (var i = 0; i < prims.length; i++) {
      var v = prims[i][key];
      m[v] = (m[v] || 0) + 1;
    }
    return m;
  }

  function buildFilter(containerId, groupId, counts, filters, labelFn, swatchFn) {
    var box = $(containerId);
    box.innerHTML = '';
    var keys = Object.keys(counts).sort(function (a, b) {
      var na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    $(groupId).hidden = keys.length < 2;
    keys.forEach(function (k) {
      var lab = document.createElement('label');
      lab.className = 'chk';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = filters[k] !== false;
      cb.onchange = function () { filters[k] = cb.checked; applyFilters(); };
      lab.appendChild(cb);
      if (swatchFn) {
        var sw = document.createElement('span');
        sw.className = 'sw';
        sw.style.background = swatchFn(k);
        lab.appendChild(sw);
      }
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = labelFn(k);
      lab.appendChild(nm);
      var ct = document.createElement('span');
      ct.className = 'ct';
      ct.textContent = counts[k];
      lab.appendChild(ct);
      box.appendChild(lab);
    });
  }

  function applyFilters() {
    var d = docs[current];
    if (!d) return;
    var f = d.filters;
    viewer.visible = function (p) {
      if (f.part[p.part] === false) return false;
      if (f.pen[p.pen] === false) return false;
      if (f.ltype[p.ltype] === false) return false;
      return true;
    };
    viewer.invalidate();
    updateStatus();
  }

  function select(i) {
    current = i;
    var d = docs[i];
    if (!d) return;
    $('hdrfile').textContent = d.name + ' — VersaCAD ' + d.doc.versionName;
    renderInfo(d);
    ['grpView', 'grpExport'].forEach(function (g) { $(g).hidden = false; });

    buildFilter('layers', 'grpLayers', tally(d.flat.prims, 'part'), d.filters.part,
      function (k) { return k === '' ? '(unnamed)' : k; }, null);
    buildFilter('pens', 'grpPens', tally(d.flat.prims, 'pen'), d.filters.pen,
      function (k) { return 'Pen ' + k; },
      function (k) { return VCAD.style.penColor(Number(k), false, viewer.opts.dark); });
    buildFilter('ltypes', 'grpLtypes', tally(d.flat.prims, 'ltype'), d.filters.ltype,
      function (k) { return VCAD.style.ltype(Number(k)).name.toLowerCase(); }, null);

    viewer.setDrawing(d.flat.prims, d.bbox);
    applyFilters();

    if (d.doc.warnings.length) {
      showWarn(d.doc.warnings.length + ' unrecognised record(s) were skipped in ' + d.name);
    }
  }

  function updateStatus() {
    var d = docs[current];
    if (!d) return;
    var shown = 0;
    for (var i = 0; i < d.flat.prims.length; i++) {
      if (!viewer.visible || viewer.visible(d.flat.prims[i])) shown++;
    }
    $('stCount').textContent = shown + ' / ' + d.flat.prims.length + ' objects';
    $('stZoom').textContent = 'zoom ' + viewer.view.scale.toPrecision(3);
  }

  // ------------------------------------------------------------ interaction

  var drag = null;

  canvas.addEventListener('pointerdown', function (ev) {
    canvas.setPointerCapture(ev.pointerId);
    drag = {
      id: ev.pointerId, x: ev.offsetX, y: ev.offsetY,
      sx: ev.offsetX, sy: ev.offsetY,
      marquee: ev.shiftKey || ev.button === 2
    };
    canvas.classList.add(drag.marquee ? 'marquee' : 'panning');
  });

  canvas.addEventListener('pointermove', function (ev) {
    var w = viewer.toWorld(ev.offsetX, ev.offsetY);
    $('stPos').textContent = 'x ' + fmt(w.x, 3) + '   y ' + fmt(w.y, 3);
    if (!drag || drag.id !== ev.pointerId) return;
    if (drag.marquee) {
      var r = $('rect');
      r.style.display = 'block';
      r.style.left = Math.min(drag.sx, ev.offsetX) + 'px';
      r.style.top = Math.min(drag.sy, ev.offsetY) + 'px';
      r.style.width = Math.abs(ev.offsetX - drag.sx) + 'px';
      r.style.height = Math.abs(ev.offsetY - drag.sy) + 'px';
    } else {
      viewer.pan(ev.offsetX - drag.x, ev.offsetY - drag.y);
      drag.x = ev.offsetX; drag.y = ev.offsetY;
    }
  });

  function endDrag(ev) {
    if (!drag) return;
    if (drag.marquee && Math.abs(ev.offsetX - drag.sx) > 4 && Math.abs(ev.offsetY - drag.sy) > 4) {
      viewer.zoomToRect(drag.sx, drag.sy, ev.offsetX, ev.offsetY);
    }
    $('rect').style.display = 'none';
    canvas.classList.remove('panning', 'marquee');
    drag = null;
    updateStatus();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (!docs.length) return;
    var f = Math.pow(1.0015, -ev.deltaY * (ev.deltaMode === 1 ? 16 : 1));
    viewer.zoomAt(ev.offsetX, ev.offsetY, Math.max(0.2, Math.min(5, f)));
    updateStatus();
  }, { passive: false });

  canvas.addEventListener('dblclick', function () { viewer.fit(); updateStatus(); });

  window.addEventListener('keydown', function (ev) {
    if (ev.target && /input|select|textarea/i.test(ev.target.tagName)) return;
    if (ev.key === 'f' || ev.key === 'F') { viewer.fit(); updateStatus(); }
    else if (ev.key === '+' || ev.key === '=') { zoomCentre(1.25); }
    else if (ev.key === '-' || ev.key === '_') { zoomCentre(1 / 1.25); }
  });

  function zoomCentre(f) {
    viewer.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, f);
    updateStatus();
  }

  // ----------------------------------------------------------- drag and drop

  var stage = $('stage');
  ['dragenter', 'dragover'].forEach(function (t) {
    stage.addEventListener(t, function (e) {
      e.preventDefault();
      $('drop').classList.add('over');
      if (!docs.length) $('drop').classList.remove('hide');
    });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    stage.addEventListener(t, function (e) {
      e.preventDefault();
      $('drop').classList.remove('over');
      if (docs.length) $('drop').classList.add('hide');
    });
  });
  stage.addEventListener('drop', function (e) {
    handleFiles(e.dataTransfer && e.dataTransfer.files);
  });

  $('btnOpen').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) { handleFiles(e.target.files); e.target.value = ''; };

  // ------------------------------------------------------------ view options

  $('optText').onchange = function () { viewer.opts.showText = this.checked; viewer.draw(); };
  $('optLt').onchange = function () { viewer.opts.showLineTypes = this.checked; viewer.draw(); };
  $('optMono').onchange = function () { viewer.opts.mono = this.checked; viewer.draw(); };
  $('optDark').onchange = function () {
    viewer.opts.dark = this.checked;
    viewer.opts.background = this.checked ? '#12151a' : '#ffffff';
    var d = docs[current];
    if (d) {
      buildFilter('pens', 'grpPens', tally(d.flat.prims, 'pen'), d.filters.pen,
        function (k) { return 'Pen ' + k; },
        function (k) { return VCAD.style.penColor(Number(k), false, viewer.opts.dark); });
    }
    viewer.draw();
  };
  $('optWidth').oninput = function () {
    viewer.opts.lineWidth = Number(this.value);
    viewer.draw();
  };

  $('btnSide').onclick = function () { $('side').classList.toggle('hidden'); viewer.resize(); };
  // --------------------------------------------------------------- theming

  // 'auto' leaves data-theme off so the stylesheet's prefers-color-scheme
  // rules decide; 'light' and 'dark' pin it.
  var THEME_KEY = 'vcadview.theme';
  var THEMES = { light: 1, dark: 1, auto: 1 };

  function applyTheme(mode) {
    if (!THEMES[mode]) mode = 'auto';
    var r = document.documentElement;
    if (mode === 'auto') r.removeAttribute('data-theme');
    else r.setAttribute('data-theme', mode);
    var el = document.querySelector('#theme input[value="' + mode + '"]');
    if (el) el.checked = true;
    return mode;
  }

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  Array.prototype.forEach.call(
    document.querySelectorAll('#theme input[name="theme"]'),
    function (el) {
      el.addEventListener('change', function () {
        if (!el.checked) return;
        applyTheme(el.value);
        try { localStorage.setItem(THEME_KEY, el.value); } catch (e) { /* private mode */ }
      });
    }
  );

  applyTheme(storedTheme() || 'auto');

  // ---------------------------------------------------------------- exports

  function download(text, name, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function baseName() {
    var d = docs[current];
    return (d ? d.name : 'drawing').replace(/\.2d$/i, '');
  }

  /** Primitives passing the current visibility filters. */
  function visiblePrims() {
    var d = docs[current];
    if (!d) return [];
    if (!viewer.visible) return d.flat.prims;
    return d.flat.prims.filter(viewer.visible);
  }

  function visibleBBox() {
    var p = visiblePrims();
    return VCAD.bounds(p) || docs[current].bbox;
  }

  $('expDxf').onclick = function () {
    var d = docs[current];
    if (!d) return;
    var f = d.filters;
    var dxf = VCAD.exportDXF(d.doc, {
      bbox: visibleBBox(),
      filter: function (e) {
        // Symbol placements are kept whenever their pen/type is visible.
        if (f.part[e.part || ''] === false) return false;
        if (f.pen[e.pen] === false) return false;
        if (f.ltype[e.ltype] === false) return false;
        return true;
      }
    });
    download(dxf, baseName() + '.dxf', 'application/dxf');
  };

  $('expSvg').onclick = function () {
    if (current < 0) return;
    var svg = VCAD.exportSVG(visiblePrims(), visibleBBox(), {
      mono: viewer.opts.mono, dark: viewer.opts.dark,
      background: viewer.opts.background
    });
    download(svg, baseName() + '.svg', 'image/svg+xml');
  };

  $('expPdf').onclick = function () {
    if (current < 0) return;
    var wh = $('pdfSize').value.split('x');
    var pdf = VCAD.exportPDF(visiblePrims(), visibleBBox(), {
      mono: viewer.opts.mono, dark: viewer.opts.dark,
      pageWidth: Number(wh[0]), pageHeight: Number(wh[1])
    });
    download(pdf, baseName() + '.pdf', 'application/pdf');
  };

  // ------------------------------------------------------------------ boot

  var ro = new ResizeObserver(function () { viewer.resize(); });
  ro.observe($('stage'));
  viewer.resize();

  // Allow ?file= for quick testing from a local server.
  var q = new URLSearchParams(location.search).get('file');
  if (q) {
    fetch(q).then(function (r) { return r.arrayBuffer(); })
      .then(function (b) {
        docs.push(loadBuffer(b, q.split('/').pop()));
        $('drop').classList.add('hide');
        select(0);
        renderFileList();
      })
      .catch(function (e) { showWarn('Could not load ' + q + ': ' + e.message); });
  }

  window.VCADApp = { viewer: viewer, docs: docs, load: loadBuffer,
                     select: select, get current() { return current; } };
})();
