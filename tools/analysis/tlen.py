import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *

ok = bad = 0
badex = []
lenhist = collections.Counter()
for p in samples():
    rs = records(p)
    for i, r in enumerate(rs[7:], 7):
        if r[1] != 0x64 or (r[0x4e] & 0xf) != 4: continue
        L = r[0x61]
        fld = r[0x62:0x80]
        s = fld.split(b'\0')[0]
        lenhist[L] += 1
        if L == len(s) and L < 30:
            ok += 1
        else:
            bad += 1
            if len(badex) < 12:
                nxt = rs[i+1] if i+1 < len(rs) else b''
                badex.append((os.path.basename(p), i, L, fld, nxt[:64]))
print(f'len byte matches inline strlen: {ok}, mismatch: {bad}')
print('\nlength byte histogram (top 30):', lenhist.most_common(30))
print('\nmismatch examples:')
for f, i, L, fld, nxt in badex:
    print(f'  {f} rec{i} lenbyte=0x{L:02x}({L}) inline={fld.split(b"\0")[0]!r}')
    print(f'      next rec: tag={nxt[0]:02x},{nxt[1]:02x} data={nxt[2:50]!r}')
