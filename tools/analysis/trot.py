import sys, os, math, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
st = collections.Counter(); vals = collections.Counter()
for p in samples():
    d = Doc(p)
    for e in d.ents:
        if e['kind'] != 'text': continue
        v = f64(e['raw'], 0x3c)
        st['zero' if v == 0 else ('rad' if 0 <= v <= 2*math.pi+1e-9 else 'OTHER')] += 1
        if v: vals[round(v, 4)] += 1
print('text @0x3c:', dict(st))
print('values:', vals.most_common(10))
# also byte 0x3b and the two bytes before the string
b3b = collections.Counter(); b60 = collections.Counter()
for p in samples():
    d = Doc(p)
    for e in d.ents:
        if e['kind'] != 'text': continue
        b3b[e['raw'][0x3b]] += 1; b60[e['raw'][0x60]] += 1
print('byte 0x3b:', dict(sorted(b3b.items())))
print('byte 0x60 (font?):', dict(sorted(b60.items())))
