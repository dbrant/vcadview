"""Run every check for the VersaCAD reader in one go.

    python tools/verify.py

Checks, in order:
  1. Python reference parser reads every sample with no unrecognised records
     and with the header's section counts landing exactly on the zero padding.
  2. The browser parser (web/js) produces byte-identical geometry to the Python
     reference, for all samples.                        [needs node]
  3. DXF/SVG/PDF export runs, and re-reading the DXF reproduces the source
     geometry (path length, bounding box and every text string). [needs node]
  4. The single-file bundle builds and inlines all scripts.

Exit code is non-zero if anything fails.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from rec import samples                       # noqa: E402
from parse import Doc                         # noqa: E402

FAILS = []
GREEN, RED, DIM, OFF = '\033[32m', '\033[31m', '\033[2m', '\033[0m'
if os.name == 'nt' and not os.environ.get('WT_SESSION'):
    GREEN = RED = DIM = OFF = ''


def ok(msg):
    print(f'  {GREEN}pass{OFF}  {msg}')


def fail(msg):
    FAILS.append(msg)
    print(f'  {RED}FAIL{OFF}  {msg}')


def find_node():
    n = shutil.which('node')
    if n:
        return n
    root = os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Packages')
    if os.path.isdir(root):
        for dirpath, _dirs, files in os.walk(root):
            if 'node.exe' in files:
                return os.path.join(dirpath, 'node.exe')
    return None


def check_parse():
    print('\n1. Python reference parser')
    for p in samples():
        name = os.path.basename(p)
        try:
            d = Doc(p)
        except Exception as exc:                       # noqa: BLE001
            fail(f'{name}: {exc}')
            continue
        if d.warn:
            fail(f'{name}: unrecognised records {dict(d.warn)}')
            continue
        tail = d.rs[d.end:]
        stray = [i for i, r in enumerate(tail) if r[1] not in (0x00,)]
        if stray:
            fail(f'{name}: {len(stray)} non-padding record(s) after the last section')
            continue
        n = len(d.ents)
        ok(f'{name:<13} v{d.version:#04x}  {len(d.rs):>5} records  {n:>5} entities  '
           f'{d.n_sym:>2} symbols')


def check_equivalence(node, tmp):
    print('\n2. Browser parser vs Python reference (identical geometry)')
    if not node:
        fail('node not found - skipped')
        return
    jsdir, pydir = os.path.join(tmp, 'js'), os.path.join(tmp, 'py')
    subprocess.run([node, os.path.join(HERE, 'dump-prims.js'), jsdir],
                   check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    subprocess.run([sys.executable, os.path.join(HERE, 'dump_prims.py'), pydir],
                   check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    total = 0
    for f in sorted(os.listdir(pydir)):
        a = open(os.path.join(pydir, f), encoding='utf-8').read()
        b = open(os.path.join(jsdir, f), encoding='utf-8').read()
        if a != b:
            fail(f'{f}: geometry differs between the two implementations')
        else:
            n = a.count('\n')
            total += n
            ok(f'{f[:-4]:<13} {n:>6} primitives identical')
    if total:
        print(f'  {DIM}{total} primitives compared{OFF}')


def check_export(node, tmp):
    print('\n3. Export and DXF round trip')
    if not node:
        fail('node not found - skipped')
        return
    out = os.path.join(tmp, 'out')
    subprocess.run([node, os.path.join(HERE, 'export-samples.js'), out],
                   check=True, cwd=ROOT, stdout=subprocess.DEVNULL)

    import dxfcheck as C
    for p in samples():
        base = os.path.basename(p)[:-3]
        d = Doc(p)
        rp, rt = C.ref_paths(d)
        for ext in ('dxf', 'svg', 'pdf'):
            f = os.path.join(out, base + '.' + ext)
            if not os.path.exists(f) or os.path.getsize(f) < 100:
                fail(f'{base}.{ext} was not written')
        blocks, ents = C.parse_dxf(os.path.join(out, base + '.dxf'))
        dp, dt = [], []
        C.emit_dxf(ents, blocks, [1, 0, 0, 1, 0, 0], dp, dt)
        rl, dl = C.polylen(rp), C.polylen(dp)
        dev = abs(dl - rl) / rl * 100 if rl else 0.0
        rb, db = C.bbox(rp), C.bbox(dp)
        bdev = max(abs(a - b) for a, b in zip(rb, db)) if rb and db else 0.0
        span = max(rb[2] - rb[0], rb[3] - rb[1]) if rb else 1.0
        strings_ok = sorted(x[1] for x in rt) == sorted(x[1] for x in dt)
        problems = []
        if dev > 0.5:
            problems.append(f'path length off by {dev:.2f}%')
        if bdev > span * 1e-3:
            problems.append(f'bbox off by {bdev:.4f}')
        if not strings_ok:
            problems.append(f'text mismatch ({len(rt)} vs {len(dt)})')
        if problems:
            fail(f'{base}: ' + '; '.join(problems))
        else:
            ok(f'{base:<13} len dev {dev:5.3f}%  bbox dev {bdev:.5f}  '
               f'{len(rt):>3} strings preserved')


def check_bundle(tmp):
    print('\n4. Single-file bundle')
    import bundle
    try:
        text, n = bundle.build()
    except Exception as exc:                           # noqa: BLE001
        fail(f'bundle failed: {exc}')
        return
    if 'script src=' in text:
        fail('bundle still references external scripts')
    elif n < 5:
        fail(f'bundle inlined only {n} scripts')
    else:
        ok(f'{n} scripts inlined, {len(text):,} bytes, no external references')


def main():
    print(f'VersaCAD .2D toolchain verification  {DIM}({len(samples())} sample files){OFF}')
    node = find_node()
    print(f'{DIM}node: {node or "not found"}{OFF}')
    tmp = tempfile.mkdtemp(prefix='vcadverify-')
    try:
        check_parse()
        check_equivalence(node, tmp)
        check_export(node, tmp)
        check_bundle(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILS:
        print(f'{RED}{len(FAILS)} check(s) failed{OFF}')
        for f in FAILS:
            print('   - ' + f)
        return 1
    print(f'{GREEN}all checks passed{OFF}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
