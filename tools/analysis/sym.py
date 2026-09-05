import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc


def pick(default_hint=None):
    """Drawing to inspect: a path or bare name on the command line, else the
    first sample found. No particular drawing is assumed to exist."""
    ss = samples()
    if len(sys.argv) > 1:
        want = sys.argv[1]
        if os.path.exists(want):
            return want
        for s in ss:
            if os.path.basename(s).lower().startswith(want.lower()):
                return s
        raise SystemExit(f'no sample matching {want!r} in samples/')
    if not ss:
        raise SystemExit('no drawings in samples/')
    return ss[0]


def hexdump(r, label):
    print(f'  [{label}]')
    for j in range(0, 128, 16):
        h = ' '.join(f'{x:02x}' for x in r[j:j+16])
        a = ''.join(chr(x) if 32 <= x < 127 else '.' for x in r[j:j+16])
        v = f64(r, j)
        ex = f'  d={v:.6g}' if plausible(v) and v != 0 else ''
        print(f'    {j:03x} {h} |{a}|{ex}')

p = pick()
d = Doc(p)
print(f'=== {os.path.basename(p)}  type8 (insert) records')
for e in d.ents:
    if e['kind'] == 'type8': hexdump(e['raw'], f"rec{e['rec']} sub=0x{e['sub']:02x}")
print('=== symbol table records (0x58)')
for i, r in enumerate(d.sym_recs): hexdump(r, f'sym{i}')
print('=== records tagged 0x66 (first record of a symbol body)')
for e in d.ents:
    if e['raw'][1] == 0x66: hexdump(e['raw'], f"rec{e['rec']}")
