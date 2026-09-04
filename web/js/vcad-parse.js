/*
 * vcad-parse.js - reader for VersaCAD .2D drawing files.
 *
 * The format was reverse engineered from sample files; see docs/FORMAT.md.
 * Everything is little-endian and laid out in fixed 128-byte records.
 */
(function (global) {
  'use strict';

  var REC = 128;

  var VERSIONS = { 0x36: '5.4', 0x3c: '6.0', 0x46: '7.0' };

  // Entity type = low nibble of the subtype byte at 0x4e.
  var T_LINE = 1, T_ARC = 3, T_TEXT = 4, T_BEZIER = 6, T_INSERT = 8;

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
          // v5.4 stores both as doubles; 6.0 and 7.0 use 32-bit floats.
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
        case T_BEZIER:
          e.kind = 'bezier';
          // Three control points, stored relative to (x, y).
          e.c1x = finite(R.f64(r, 0x50), 0); e.c1y = finite(R.f64(r, 0x58), 0);
          e.c2x = finite(R.f64(r, 0x60), 0); e.c2y = finite(R.f64(r, 0x68), 0);
          e.c3x = finite(R.f64(r, 0x70), 0); e.c3y = finite(R.f64(r, 0x78), 0);
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
        // 0x66 marks the first record of a symbol body, but it is a perfectly
        // ordinary entity record as well and has to be read like one. Skipping
        // it loses one object per symbol -- for the sample drawings that is the
        // head of the figure used for scale, drawn wherever the symbol lands.
        if (tag !== 0x64 && tag !== 0x66) {           // stray or continuation record
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

    var stats = {};
    for (var k = 0; k < entities.length; k++) {
      stats[entities[k].kind] = (stats[entities[k].kind] || 0) + 1;
    }

    return {
      name: name || 'drawing',
      version: version,
      versionName: VERSIONS[version] || ('0x' + version.toString(16)),
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
