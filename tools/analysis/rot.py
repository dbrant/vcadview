import sys, os, math, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
import struct
for p in samples():
    d = Doc(p)
    st = collections.Counter(); vals = collections.Counter()
    for e in d.ents:
        if e['kind'] not in ('type8','arc'): continue
        v = f64(e['raw'], 0x3c)
        k = e['kind']
        if v == 0: st[k+':zero'] += 1
        elif abs(v) <= 2*math.pi + 1e-9: st[k+':rad'] += 1
        else: st[k+':OTHER'] += 1
        if e['kind']=='type8' and v: vals[round(v,4)] += 1
    print(f'{os.path.basename(p):14s} {dict(st)}')
    if vals: print('     insert rot values:', vals.most_common(8))
