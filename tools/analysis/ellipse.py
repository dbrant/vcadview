import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc

def endpoints(e, mode):
    rx, ry, rot = e['rx'], e['ry'], e['rot']
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for a in (e['a1'], e['a2']):
        if mode == 'param':
            t = a
        else:  # 'true': a is the real polar angle in the ellipse frame
            t = math.atan2(rx*math.sin(a), ry*math.cos(a))
        px, py = rx*math.cos(t), ry*math.sin(t)
        out.append((e['x']+px*c-py*s, e['y']+px*s+py*c))
    return out

for p in samples():
    d = Doc(p)
    pts = []
    for e in d.ents:
        if e['kind'] == 'line':
            pts.append((e['x'], e['y'])); pts.append((e['x']+e['dx'], e['y']+e['dy']))
    if not pts: continue
    # bucket line endpoints on a grid for fast nearest lookup
    G = 0.05
    grid = {}
    for x, y in pts: grid.setdefault((round(x/G), round(y/G)), []).append((x, y))
    def near(q):
        gx, gy = round(q[0]/G), round(q[1]/G)
        best = 1e18
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                for r in grid.get((gx+dx, gy+dy), ()):
                    best = min(best, math.hypot(r[0]-q[0], r[1]-q[1]))
        return best
    res = {}
    for mode in ('param', 'true'):
        hits = n = 0
        for e in d.ents:
            if e['kind'] != 'arc': continue
            if abs(abs(e['rx']) - abs(e['ry'])) < 1e-9: continue   # circles: modes identical
            if e['rx'] == 0 or e['ry'] == 0: continue
            for q in endpoints(e, mode):
                n += 1
                if near(q) < 0.02: hits += 1
        res[mode] = (hits, n)
    if res['param'][1]:
        print(f"{os.path.basename(p):14s} elliptical-arc endpoints touching a line endpoint:  "
              f"param={res['param'][0]}/{res['param'][1]}   true={res['true'][0]}/{res['true'][1]}")
