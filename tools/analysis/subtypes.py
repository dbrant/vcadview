import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *

hist = collections.Counter()
perfile = collections.defaultdict(collections.Counter)
b4f = collections.Counter()
layers = collections.Counter()
for p in samples():
    n = os.path.basename(p)
    for r in records(p)[7:]:
        if r[1] != 0x64: continue
        st = r[0x4e]
        hist[st] += 1
        perfile[n][st] += 1
        b4f[r[0x4f]] += 1
        layers[r[0x44:0x4b].split(b'\0')[0].decode('latin1')] += 1

print('subtype byte @0x4e histogram (0x64 records):')
for k, v in sorted(hist.items()):
    ch = chr(k) if 32 <= k < 127 else '.'
    print(f'  0x{k:02x} ({k:3d}) {ch!r}  n={v}')
print('\nbyte @0x4f histogram:', dict(b4f))
print('\nlayer names @0x44:', dict(layers))
print('\nper file:')
for f, c in perfile.items():
    print(f'  {f:14s} ' + ' '.join(f'{k:02x}:{v}' for k, v in sorted(c.items())))
