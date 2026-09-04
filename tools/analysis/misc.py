import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
want = {5, 6, 7, 9}
seen = {k: 0 for k in want}
for p in samples():
    d = Doc(p)
    for e in d.ents:
        t = e.get('type')
        if t not in want or seen[t] >= 3: continue
        seen[t] += 1
        r = e['raw']
        print(f"--- {os.path.basename(p)} rec{e['rec']} type={t} sub=0x{e['sub']:02x} flags=0x{r[0]:02x} attr={r[2:8].hex()} layer={e['layer']!r}")
        for j in range(0, 128, 16):
            h = ' '.join(f'{x:02x}' for x in r[j:j+16])
            a = ''.join(chr(x) if 32 <= x < 127 else '.' for x in r[j:j+16])
            print(f'   {j:03x} {h} |{a}|')
        cand = []
        for o in (0x1c,0x24,0x2c,0x34,0x3c,0x50,0x58,0x60,0x68,0x6b,0x70,0x73,0x78):
            v = f64(r, o)
            if plausible(v) and v != 0: cand.append(f'{o:02x}={v:.5g}')
        print('   doubles:', ' '.join(cand))
