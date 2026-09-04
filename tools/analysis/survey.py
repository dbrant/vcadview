import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *

tally = collections.Counter()
per_file = {}
for p in samples():
    rs = records(p)
    c = collections.Counter()
    for r in rs[7:]:                       # skip 7 header records
        c[(r[0], r[1])] += 1
    per_file[os.path.basename(p)] = c
    tally.update(c)

print('GLOBAL tag histogram (byte0, byte1):')
for (b0, b1), n in sorted(tally.items(), key=lambda kv: -kv[1]):
    print(f'  b0=0x{b0:02x} b1=0x{b1:02x} ({b1:3d})  n={n}')

print('\nPer-file (byte1 only):')
for f, c in per_file.items():
    m = collections.Counter()
    for (b0, b1), n in c.items(): m[b1] += n
    print(f'  {f:14s} ' + '  '.join(f'{k:02x}:{v}' for k, v in sorted(m.items())))

print('\nbyte0 flag bits seen:')
b0s = collections.Counter()
for c in per_file.values():
    for (b0, b1), n in c.items(): b0s[b0] += n
print('  ', dict(b0s))
