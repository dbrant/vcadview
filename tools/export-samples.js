/* Generate DXF/SVG/PDF for every sample.  node tools/export-samples.js OUTDIR */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['vcad-parse.js', 'vcad-geom.js', 'vcad-style.js', 'vcad-export.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'web', 'js', f), 'utf8'), sandbox, { filename: f });
}
const VCAD = sandbox.VCAD;

const outdir = process.argv[2];
fs.mkdirSync(outdir, { recursive: true });
const dir = path.join(root, 'samples');
for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.2d')).sort()) {
  const b = fs.readFileSync(path.join(dir, f));
  const doc = VCAD.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), f);
  const fl = VCAD.flatten(doc);
  const bb = VCAD.bounds(fl.prims) || doc.extents;
  const base = f.replace(/\.2D$/i, '');
  const dxf = VCAD.exportDXF(doc, { bbox: bb });
  const svg = VCAD.exportSVG(fl.prims, bb, {});
  const pdf = VCAD.exportPDF(fl.prims, bb, {});
  fs.writeFileSync(path.join(outdir, base + '.dxf'), dxf, 'latin1');
  fs.writeFileSync(path.join(outdir, base + '.svg'), svg, 'utf8');
  fs.writeFileSync(path.join(outdir, base + '.pdf'), pdf, 'latin1');
  console.log(base.padEnd(12),
    'dxf', String(dxf.length).padStart(9),
    'svg', String(svg.length).padStart(8),
    'pdf', String(pdf.length).padStart(8),
    'prims', fl.prims.length);
}
