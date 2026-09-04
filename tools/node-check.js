/*
 * Cross-check the browser parser against the Python reference by dumping
 * per-file statistics and a geometry digest. Run:  node tools/node-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['vcad-parse.js', 'vcad-geom.js', 'vcad-style.js', 'vcad-export.js']) {
  const p = path.join(root, 'web', 'js', f);
  if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
}
const VCAD = sandbox.VCAD;

const dir = path.join(root, 'samples');
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.2d')).sort();
const out = {};
for (const f of files) {
  const b = fs.readFileSync(path.join(dir, f));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  let doc;
  try {
    doc = VCAD.parse(ab, f);
  } catch (e) {
    console.log(f, 'PARSE ERROR', e.message);
    continue;
  }
  const fl = VCAD.flatten(doc);
  const bb = VCAD.bounds(fl.prims);
  // digest: sum of coordinates, rounded, so Python and JS can be compared
  let sx = 0, sy = 0, np = 0;
  for (const p of fl.prims) {
    const pts = p.k === 't' ? [p.x, p.y] : VCAD.tessellate(p, 1);
    for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sy += pts[i + 1]; np++; }
  }
  out[f] = {
    version: doc.versionName,
    sections: doc.sections,
    stats: doc.stats,
    warnings: doc.warnings.length,
    counts: fl.counts,
    missing: Object.keys(fl.missingSymbols).length,
    prims: fl.prims.length,
    bbox: bb ? [+bb.minx.toFixed(4), +bb.miny.toFixed(4), +bb.maxx.toFixed(4), +bb.maxy.toFixed(4)] : null,
    digest: [+sx.toFixed(2), +sy.toFixed(2), np],
    extents: [+doc.extents.minx.toFixed(3), +doc.extents.maxx.toFixed(3),
              +doc.extents.miny.toFixed(3), +doc.extents.maxy.toFixed(3)]
  };
}
console.log(JSON.stringify(out, null, 1));
