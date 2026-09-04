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

        case 'text': {
          if (!e.text || !e.h) return;
          p = apply(m, e.x, e.y);
          // Local text axes -> world, so mirrored/rotated symbols carry through.
          var ax = applyVec(m, Math.cos(e.rot), Math.sin(e.rot));
          var ay = applyVec(m, -Math.sin(e.rot), Math.cos(e.rot));
          base.k = 't';
          base.x = p[0]; base.y = p[1];
          base.rot = Math.atan2(ax[1], ax[0]);
          base.w = e.w * Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1]);
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
          // world = T(insert) . R(rot) . S(sx,sy) . T(-base)
          var local = mul(
            [cr, sr, -sr, cr, e.x, e.y],
            mul([e.sx, 0, 0, e.sy, 0, 0], [1, 0, 0, 1, -sym.baseX, -sym.baseY])
          );
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
  global.VCAD.dimSegments = dimSegments;
  global.VCAD.isFullTurn = isFullTurn;
})(typeof window !== 'undefined' ? window : globalThis);
