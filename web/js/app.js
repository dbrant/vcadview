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
