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
