import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc

tot = collections.Counter()
for p in samples():
    d = Doc(p)
    if not d.sym_recs: continue
    by = {}
    for r in d.sym_recs:
        g = r[2:0x0b].split(b'\0')[0].decode('latin1')
        by[(g, u16(r,0x14))] = r[0x0b:0x14].split(b'\0')[0].decode('latin1')
    res = collections.Counter()
    ex = []
    for e in d.ents:
        if e['kind'] != 'type8': continue
        r = e['raw']
        g = r[0x50:0x59].split(b'\0')[0].decode('latin1')
        sid = u16(r, 0x59)
        hit = by.get((g, sid >> 1))
        res['ok' if hit else 'MISS'] += 1
        res[f'lowbit{sid & 1}'] += 1
        if not hit and len(ex) < 5: ex.append((e['rec'], g, sid))
    print(f"{os.path.basename(p):14s} {dict(res)}")
    for x in ex: print('    miss:', x)
    tot.update(res)
print('TOTAL', dict(tot))
