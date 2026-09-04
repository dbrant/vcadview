/* Dump the flattened display list in a canonical text form (for diffing
   against the Python reference implementation).  node tools/dump-prims.js OUTDIR */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['vcad-parse.js', 'vcad-geom.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'web', 'js', f), 'utf8'), sandbox, { filename: f });
}
const VCAD = sandbox.VCAD;
const outdir = process.argv[2];
fs.mkdirSync(outdir, { recursive: true });

const n = (v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
const dir = path.join(root, 'samples');
for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.2d')).sort()) {
  const b = fs.readFileSync(path.join(dir, f));
  const doc = VCAD.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), f);
  const lines = [];
  for (const p of VCAD.flatten(doc).prims) {
    if (p.k === 'l') lines.push(`l ${n(p.x1)} ${n(p.y1)} ${n(p.x2)} ${n(p.y2)} ${p.pen} ${p.ltype}`);
    else if (p.k === 'a') lines.push(`a ${n(p.cx)} ${n(p.cy)} ${n(p.ux)} ${n(p.uy)} ${n(p.vx)} ${n(p.vy)} ${n(p.a1)} ${n(p.a2)} ${p.pen} ${p.ltype}`);
    else if (p.k === 'b') lines.push('b ' + p.p.map(n).join(' ') + ` ${p.pen} ${p.ltype}`);
    else if (p.k === 't') lines.push(`t ${n(p.x)} ${n(p.y)} ${n(p.h)} ${n(p.w)} ${n(p.rot)} ${p.pen} ${p.ltype} |${p.s}|`);
  }
  fs.writeFileSync(path.join(outdir, f + '.txt'), lines.join('\n') + '\n');
  console.log(f, lines.length);
}
