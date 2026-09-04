import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
# locate first index of each rare tag per file
want = {0x40,0x41,0x43,0x44,0x45,0x58,0x66,0x00}
for p in samples():
    rs = records(p)
    seen = {}
    for i, r in enumerate(rs[7:], start=7):
        if r[1] in want and r[1] not in seen:
            seen[r[1]] = i
    if seen:
        print(os.path.basename(p), {hex(k): v for k, v in sorted(seen.items())})
