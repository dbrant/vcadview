import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
from PIL import Image, ImageDraw

def geom(d, arcmode='startend'):
    segs = []
    for e in d.ents:
        if e['kind'] == 'line':
            segs.append(((e['x'], e['y']), (e['x']+e['dx'], e['y']+e['dy'])))
        elif e['kind'] == 'arc':
            rx, ry, a1, a2 = e['rx'], e['ry'], e['a1'], e['a2']
            if rx == 0 and ry == 0: continue
            if arcmode == 'startend':
                sweep = a2 - a1
                if sweep <= 0: sweep += 2*math.pi
            else:
                sweep = a2
            n = max(6, int(abs(sweep)/0.15))
            pts = []
            for k in range(n+1):
                a = a1 + sweep*k/n
                pts.append((e['x']+rx*math.cos(a), e['y']+ry*math.sin(a)))
            for k in range(n): segs.append((pts[k], pts[k+1]))
    return segs

def draw(segs, out, W=1400):
    if not segs: print('no segs'); return
    xs = [p[0] for s in segs for p in s]; ys = [p[1] for s in segs for p in s]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w, h = max(x1-x0, 1e-9), max(y1-y0, 1e-9)
    H = max(50, int(W*h/w))
    sc = (W-20)/w
    im = Image.new('RGB', (W, H+20), 'white'); dr = ImageDraw.Draw(im)
    for (ax, ay), (bx, by) in segs:
        dr.line([(10+(ax-x0)*sc, H+10-(ay-y0)*sc), (10+(bx-x0)*sc, H+10-(by-y0)*sc)], fill='black')
    im.save(out)
    print(f'{out}  {len(segs)} segs  bbox=({x0:.2f},{y0:.2f})-({x1:.2f},{y1:.2f})  {W}x{H+20}')

if __name__ == '__main__':
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    for p in samples():
        n = os.path.basename(p).replace('.2D', '')
        d = Doc(p)
        draw(geom(d), os.path.join(outdir, n + '.png'))
