import sys, os, struct, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc

for p in samples():
    d = Doc(p)
    if not d.sym_recs: continue
    print(f'=== {os.path.basename(p)}  ({len(d.sym_recs)} symbols)')
    syms = []
    for i, r in enumerate(d.sym_recs):
        syms.append(dict(idx=u16(r,0x14), start=u16(r,0x16), n=u16(r,0x18),
                         g=r[2:0x0b].split(b'\0')[0].decode('latin1'),
                         nm=r[0x0b:0x14].split(b'\0')[0].decode('latin1'),
                         d=[f64(r,o) for o in (0x1a,0x22,0x2a,0x32)]))
    for s in syms:
        print(f"   sym idx={s['idx']:3d} grp={s['g']:<10s} name={s['nm']:<10s} rec[{s['start']}..{s['start']+s['n']}) "
              f"d=({s['d'][0]:.3f},{s['d'][1]:.3f},{s['d'][2]:.3f},{s['d'][3]:.3f})")
    ins = [e for e in d.ents if e['kind'] == 'type8']
    print(f'   {len(ins)} inserts; matching base point (0x2c,0x34) -> symbol:')
    cand = collections.Counter()
    shown = 0
    for e in ins:
        r = e['raw']
        bx, by = f64(r,0x2c), f64(r,0x34)
        m = [s for s in syms if abs(s['d'][2]-bx) < 1e-9 and abs(s['d'][3]-by) < 1e-9]
        cand['match' if len(m)==1 else ('multi' if len(m)>1 else 'none')] += 1
        if shown < 6:
            shown += 1
            print(f"      rec{e['rec']:5d} grp={r[0x50:0x57].split(b'\0')[0].decode('latin1'):<8s} "
                  f"b59={r[0x59]:3d} b5a={r[0x5a]:3d} b7b={r[0x7b]:3d} "
                  f"sc=({f64(r,0x6b):.4f},{f64(r,0x73):.4f}) d5b={f64(r,0x5b):.3f} d63={f64(r,0x63):.3f} "
                  f"-> {[s['nm'] for s in m]}")
    print('   base-point match:', dict(cand))
