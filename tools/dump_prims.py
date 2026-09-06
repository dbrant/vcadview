"""Python reference: dump the flattened display list in the same canonical
text form as tools/dump-prims.js, so the two implementations can be diffed."""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import *
from parse import Doc

MAX_DEPTH = 12

# Mirrors TEXT_WIDTH_SCALE in web/js/vcad-geom.js.
TEXT_WIDTH_SCALE = 1.25

TAU = 2 * math.pi


def arc_sweep(a1, a2, cw):
    """Signed sweep; mirrors VCAD.arcSweep in web/js/vcad-geom.js."""
    s = (a2 - a1) % TAU
    if s < 0:
        s += TAU
    if s < 1e-12:
        return -TAU if cw else TAU
    return s - TAU if cw else s



def mul(m, n):
    return [m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1],
            m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3],
            m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5]]


def ap(m, x, y):  return (m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5])
def av(m, x, y):  return (m[0]*x + m[2]*y, m[1]*x + m[3]*y)


def dim_segments(e):
    """Mirrors VCAD.dimSegments in web/js/vcad-geom.js."""
    horiz = e['horiz']
    span = e['dx'] if horiz else e['dy']
    ln = abs(span)
    if not (ln > 1e-9):
        return []
    off = e['offset']
    d = -1 if span < 0 else 1
    at = (lambda u: (d*u, off)) if horiz else (lambda u: (off, d*u))
    segs = []
    start, end = at(0), at(ln)
    segs.append((0.0, 0.0, start[0], start[1]))
    segs.append((e['dx'], e['dy'], end[0], end[1]))
    half = min(abs(e['gapHalf']), ln/2)
    if half < 1e-9:
        segs.append((start[0], start[1], end[0], end[1]))
    else:
        mid = min(abs(e['gapMid']), ln)
        g0, g1 = at(max(0.0, mid-half)), at(min(ln, mid+half))
        segs.append((start[0], start[1], g0[0], g0[1]))
        segs.append((g1[0], g1[1], end[0], end[1]))
    lab = e.get('label')
    a = lab['h']*0.65 if (lab and lab['h'] > 0) else ln*0.08
    a = max(1e-6, min(a, ln*0.2))
    ux, uy = (d, 0) if horiz else (0, d)
    px, py = -uy, ux
    for tip, sg in ((start, 1), (end, -1)):
        for k in (-1, 1):
            segs.append((tip[0], tip[1],
                         tip[0] + ux*a*sg + px*a*0.38*k,
                         tip[1] + uy*a*sg + py*a*0.38*k))
    return segs



def ang_dim_segments(e):
    """Mirrors VCAD.angDimSegments in web/js/vcad-geom.js."""
    r0, r = abs(e['r0']), abs(e['rArc'])
    if not (r > 1e-9) or abs(e['sweep']) < 1e-9:
        return None
    vx, vy = -r0*math.cos(e['a0']), -r0*math.sin(e['a0'])
    a1 = e['a0']
    a2 = a1 + e['sweep']
    d = -1 if e['sweep'] < 0 else 1
    lines, arcs = [], []
    lines.append((vx + r0*math.cos(a1), vy + r0*math.sin(a1),
                  vx + r*math.cos(a1), vy + r*math.sin(a1)))
    lines.append((vx + r0*math.cos(a2), vy + r0*math.sin(a2),
                  vx + r*math.cos(a2), vy + r*math.sin(a2)))
    half = min(e['gapHalf'], abs(e['sweep'])/2)
    if half < 1e-9:
        arcs.append((vx, vy, r, a1, a2))
    else:
        mid = a1 + e['gapMid']
        arcs.append((vx, vy, r, a1, mid - d*half))
        arcs.append((vx, vy, r, mid + d*half, a2))
    lab = e.get('label')
    a = lab['h']*0.65 if (lab and lab['h'] > 0) else r*0.08
    a = max(1e-6, min(a, r*abs(e['sweep'])*0.3))
    for ang, sgn in ((a1, 1), (a2, -1)):
        sg = sgn*d
        tipx, tipy = vx + r*math.cos(ang), vy + r*math.sin(ang)
        tx, ty = -math.sin(ang)*sg, math.cos(ang)*sg
        px, py = -ty, tx
        for k in (-1, 1):
            lines.append((tipx, tipy, tipx + tx*a + px*a*0.38*k, tipy + ty*a + py*a*0.38*k))
    return lines, arcs


def flatten(d):
    syms = {}
    for r in d.sym_recs:
        g = r[2:0x0b].split(b'\0')[0].decode('latin1')
        syms[(g, u16(r, 0x14))] = dict(start=u16(r, 0x16), n=u16(r, 0x18),
                                       bx=f64(r, 0x2a), by=f64(r, 0x32))
    byrec = {e['rec']: e for e in d.ents}
    out = []

    def rot_of(e):
        v = f64(e['raw'], 0x3c)
        return v if (v == v and -7 <= v <= 7) else 0.0

    def emit_range(start, count, m, depth):
        if depth > MAX_DEPTH:
            return
        i, stop, guard = start, start + count, 0
        while i < stop and guard <= count + 4:
            guard += 1
            e = byrec.get(i)
            if e is None:
                i += 1
                continue
            i += 2 if e.get('cont') else 1
            emit(e, m, depth)

    def emit(e, m, depth):
        k = e['kind']
        pen, lt = e['raw'][5], e['raw'][7]
        if k == 'line':
            p = ap(m, e['x'], e['y'])
            q = ap(m, e['x'] + e['dx'], e['y'] + e['dy'])
            if p == q:
                return
            out.append(('l', p[0], p[1], q[0], q[1], pen, lt))
        elif k == 'arc':
            if not (e['rx'] or e['ry']):
                return
            ro = rot_of(e)
            c, s = math.cos(ro), math.sin(ro)
            U = av(m, e['rx']*c, e['rx']*s)
            V = av(m, -e['ry']*s, e['ry']*c)
            p = ap(m, e['x'], e['y'])
            sweep = arc_sweep(e['a1'], e['a2'], e['cw'])
            out.append(('a', p[0], p[1], U[0], U[1], V[0], V[1], e['a1'], e['a1']+sweep, pen, lt))
        elif k == 'type6':
            r = e['raw']
            cs = [f64(r, 0x50), f64(r, 0x58), f64(r, 0x60), f64(r, 0x68), f64(r, 0x70), f64(r, 0x78)]
            pts = [ap(m, e['x'], e['y'])]
            for j in range(3):
                pts.append(ap(m, e['x'] + cs[j*2], e['y'] + cs[j*2+1]))
            out.append(('b',) + tuple(v for q in pts for v in q) + (pen, lt))
        elif k == 'dim':
            ds = dim_segments(e)
            if not ds:
                return
            ro = rot_of(e)
            cr, sr = math.cos(ro), math.sin(ro)
            dm = mul(m, [cr, sr, -sr, cr, e['x'], e['y']])
            for q in ds:
                a = ap(dm, q[0], q[1])
                b = ap(dm, q[2], q[3])
                if a == b:
                    continue
                out.append(('l', a[0], a[1], b[0], b[1], pen, lt))
        elif k == 'angdim':
            ad = ang_dim_segments(e)
            if not ad:
                return
            am = mul(m, [1, 0, 0, 1, e['x'], e['y']])
            for q in ad[0]:
                a = ap(am, q[0], q[1]); b = ap(am, q[2], q[3])
                if a == b:
                    continue
                out.append(('l', a[0], a[1], b[0], b[1], pen, lt))
            for q in ad[1]:
                c = ap(am, q[0], q[1])
                U = av(am, q[2], 0); V = av(am, 0, q[2])
                out.append(('a', c[0], c[1], U[0], U[1], V[0], V[1], q[3], q[4], pen, lt))
        elif k == 'text':
            if not e['text'] or not e['h']:
                return
            ro = rot_of(e)
            p = ap(m, e['x'], e['y'])
            axx, axy = av(m, math.cos(ro), math.sin(ro))
            ayx, ayy = av(m, -math.sin(ro), math.cos(ro))
            out.append(('t', p[0], p[1],
                        e['h']*math.hypot(ayx, ayy),
                        e['w']*TEXT_WIDTH_SCALE*math.hypot(axx, axy),
                        math.atan2(axy, axx), pen, lt, e['text']))
        elif k == 'type8':
            r = e['raw']
            g = r[0x50:0x59].split(b'\0')[0].decode('latin1')
            s = syms.get((g, u16(r, 0x59) >> 1))
            if not s:
                return
            ro = rot_of(e)
            sx, sy = f64(r, 0x6b), f64(r, 0x73)
            sx = sx if (sx == sx and sx != 0) else 1.0
            sy = sy if (sy == sy and sy != 0) else 1.0
            cr, sr = math.cos(ro), math.sin(ro)
            local = mul([cr, sr, -sr, cr, e['x'], e['y']], [sx, 0, 0, sy, 0, 0])
            emit_range(s['start'], s['n'], mul(m, local), depth+1)

    for e in d.ents:
        if e['sect'] == 'main':
            emit(e, [1, 0, 0, 1, 0, 0], 0)
    return out


def fmt(v):
    return '%.6f' % (0.0 if abs(v) < 5e-7 else v)


if __name__ == '__main__':
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    for p in samples():
        d = Doc(p)
        lines = []
        for t in flatten(d):
            if t[0] == 't':
                lines.append('t ' + ' '.join(fmt(v) for v in t[1:6]) +
                             f' {t[6]} {t[7]} |{t[8]}|')
            else:
                lines.append(t[0] + ' ' + ' '.join(fmt(v) for v in t[1:-2]) +
                             f' {t[-2]} {t[-1]}')
        fn = os.path.join(outdir, os.path.basename(p) + '.txt')
        open(fn, 'w', newline='').write('\n'.join(lines) + '\n')
        print(os.path.basename(p), len(lines))
