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

        case 'text': {
          if (!e.text) break;
          head('TEXT');
          w.g(10, num(e.x)).g(20, num(e.y)).g(30, '0.0');
          w.g(40, num(e.h));
          w.g(1, e.text);
          if (e.rot) w.g(50, num(e.rot * 180 / Math.PI));
          var wf = e.h > 0 ? e.w / (DXF_CHAR_ADVANCE * e.h) : 1;
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
       .g(10, num(b.sym.baseX)).g(20, num(b.sym.baseY)).g(30, '0.0').g(3, n);
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
