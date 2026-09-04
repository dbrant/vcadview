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
