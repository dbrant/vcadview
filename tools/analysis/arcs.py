import sys, os, math
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

p = pick()
d = Doc(p)
print(f'# {os.path.basename(p)}')
print(f'{"rec":>5} {"rx":>9} {"ry":>9} {"a1":>8} {"a2":>8} {"rot":>8}  ratio  sub  0x02-07')
for e in d.ents:
    if e['kind'] != 'arc': continue
    rx, ry = e['rx'], e['ry']
    ratio = (max(abs(rx),abs(ry))+1e-12)/(min(abs(rx),abs(ry))+1e-12)
    flag = ' <<<' if ratio > 3 else ''
    print(f"{e['rec']:5d} {rx:9.4f} {ry:9.4f} {e['a1']:8.4f} {e['a2']:8.4f} {e['rot']:8.4f} {ratio:6.1f} 0x{e['sub']:02x} {e['attr'].hex()}{flag}")
