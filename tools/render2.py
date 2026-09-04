import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import *
from parse import Doc
from PIL import Image, ImageDraw

def build(d):
    syms = {}
    for r in d.sym_recs:
        g = r[2:0x0b].split(b'\0')[0].decode('latin1')
        syms[(g, u16(r,0x14))] = dict(
            name=r[0x0b:0x14].split(b'\0')[0].decode('latin1'),
            start=u16(r,0x16), n=u16(r,0x18),
            bx=f64(r,0x2a), by=f64(r,0x32))
    byrec = {e['rec']: e for e in d.ents}
    return syms, byrec

def arcpts(x, y, rx, ry, a1, a2, rot):
    sweep = a2 - a1
    if sweep <= 1e-12: sweep += 2*math.pi
    n = max(8, int(abs(sweep)/0.08))
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for k in range(n+1):
        a = a1 + sweep*k/n
        px, py = rx*math.cos(a), ry*math.sin(a)
        out.append((x + px*c - py*s, y + px*s + py*c))
    return out

def emit(d, syms, byrec, segs, lo, hi, M, depth=0):
    if depth > 8: return
    i = lo
    while i < hi:
        e = byrec.get(i)
        if e is None: i += 1; continue
        i += 1
        if e.get('cont'): i += 1
        k = e['kind']
        if k == 'line':
            a = M(e['x'], e['y']); b = M(e['x']+e['dx'], e['y']+e['dy'])
            segs.append((a, b))
        elif k == 'arc':
            pts = [M(*p) for p in arcpts(e['x'], e['y'], e['rx'], e['ry'], e['a1'], e['a2'], e['rot'])]
            segs.extend(zip(pts, pts[1:]))
        elif k == 'type8':
            r = e['raw']
            g = r[0x50:0x59].split(b'\0')[0].decode('latin1')
            s = syms.get((g, u16(r,0x59) >> 1))
            if not s: continue
            ix, iy = f64(r,0x1c), f64(r,0x24)
            rot = f64(r,0x3c); sx = f64(r,0x6b); sy = f64(r,0x73)
            co, si = math.cos(rot), math.sin(rot)
            bx, by = s['bx'], s['by']
            def M2(px, py, _M=M, bx=bx, by=by, sx=sx, sy=sy, co=co, si=si, ix=ix, iy=iy):
                ux, uy = (px-bx)*sx, (py-by)*sy
                return _M(ix + ux*co - uy*si, iy + ux*si + uy*co)
            emit(d, syms, byrec, segs, s['start'], s['start']+s['n'], M2, depth+1)

def geom(d):
    syms, byrec = build(d)
    segs = []
    emit(d, syms, byrec, segs, d.ent_start, d.ent_start + d.n_part1, lambda x, y: (x, y))
    return segs

def draw(segs, out, W=1500):
    xs = [p[0] for s in segs for p in s]; ys = [p[1] for s in segs for p in s]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w, h = max(x1-x0,1e-9), max(y1-y0,1e-9)
    H = max(50, int(W*h/w)); sc = (W-20)/w
    im = Image.new('RGB', (W, H+20), 'white'); dr = ImageDraw.Draw(im)
    for (ax,ay),(bx,by) in segs:
        dr.line([(10+(ax-x0)*sc, H+10-(ay-y0)*sc), (10+(bx-x0)*sc, H+10-(by-y0)*sc)], fill='black')
    im.save(out)
    print(f'{os.path.basename(out)} {len(segs)} segs bbox=({x0:.2f},{y0:.2f})-({x1:.2f},{y1:.2f})')

if __name__ == '__main__':
    outdir = sys.argv[1]; os.makedirs(outdir, exist_ok=True)
    for p in samples():
        d = Doc(p)
        draw(geom(d), os.path.join(outdir, os.path.basename(p).replace('.2D','.png')))
