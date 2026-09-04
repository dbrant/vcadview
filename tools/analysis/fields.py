import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *

# group 0x64 records by low nibble of subtype byte 0x4e
groups = collections.defaultdict(list)
for p in samples():
    for r in records(p)[7:]:
        if r[1] != 0x64: continue
        groups[r[0x4e] & 0x0f].append(r)

for lo in sorted(groups):
    rs = groups[lo]
    n = len(rs)
    print(f'\n=== low-nibble {lo:x}  (n={n})')
    # per byte offset: how often non-zero
    nz = [0]*128
    vals = [collections.Counter() for _ in range(128)]
    for r in rs:
        for i in range(128):
            if r[i]: nz[i] += 1
            if len(vals[i]) < 40: vals[i][r[i]] += 1
    line = ''
    for i in range(128):
        frac = nz[i]/n
        line += '.' if frac == 0 else ('#' if frac > 0.9 else ('+' if frac > 0.3 else '-'))
    for j in range(0, 128, 32):
        print(f'  {j:03x} {line[j:j+32]}')
    # constant bytes
    const = [(i, list(vals[i])[0]) for i in range(128) if len(vals[i]) == 1 and list(vals[i])[0] != 0]
    if const: print('  const:', ' '.join(f'{i:02x}={v:02x}' for i, v in const))
