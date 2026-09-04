import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
H = [collections.Counter() for _ in range(8)]
byfile = collections.defaultdict(lambda: [collections.Counter() for _ in range(8)])
hi = collections.Counter()
for p in samples():
    d = Doc(p)
    for e in d.ents:
        if e['kind'] == 'symhdr': continue
        r = e['raw']
        for i in range(8): H[i][r[i]] += 1; byfile[os.path.basename(p)][i][r[i]] += 1
        hi[e['sub'] >> 4] += 1
for i in (0, 2, 3, 4, 5, 6, 7):
    print(f'byte 0x{i:02x}: ', dict(sorted(H[i].items())))
print('subtype high nibble:', dict(sorted(hi.items())))
print()
for f, hh in byfile.items():
    print(f'{f:14s} b02={dict(sorted(hh[2].items()))}')
    print(f'{"":14s} b05={dict(sorted(hh[5].items()))} b06={dict(sorted(hh[6].items()))} b07={dict(sorted(hh[7].items()))}')
