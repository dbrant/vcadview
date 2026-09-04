"""Python reference: dump the flattened display list in the same canonical
text form as tools/dump-prims.js, so the two implementations can be diffed."""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import *
from parse import Doc

MAX_DEPTH = 12


def mul(m, n):
    return [m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1],
            m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3],
            m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5]]


def ap(m, x, y):  return (m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5])
def av(m, x, y):  return (m[0]*x + m[2]*y, m[1]*x + m[3]*y)


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
            sweep = e['a2'] - e['a1']
            if sweep <= 1e-12:
                sweep += 2*math.pi
            out.append(('a', p[0], p[1], U[0], U[1], V[0], V[1], e['a1'], e['a1']+sweep, pen, lt))
        elif k == 'type6':
            r = e['raw']
            cs = [f64(r, 0x50), f64(r, 0x58), f64(r, 0x60), f64(r, 0x68), f64(r, 0x70), f64(r, 0x78)]
            pts = [ap(m, e['x'], e['y'])]
            for j in range(3):
                pts.append(ap(m, e['x'] + cs[j*2], e['y'] + cs[j*2+1]))
            out.append(('b',) + tuple(v for q in pts for v in q) + (pen, lt))
        elif k == 'text':
            if not e['text'] or not e['h']:
                return
            ro = rot_of(e)
            p = ap(m, e['x'], e['y'])
            axx, axy = av(m, math.cos(ro), math.sin(ro))
            ayx, ayy = av(m, -math.sin(ro), math.cos(ro))
            out.append(('t', p[0], p[1],
                        e['h']*math.hypot(ayx, ayy), e['w']*math.hypot(axx, axy),
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
            local = mul([cr, sr, -sr, cr, e['x'], e['y']],
                        mul([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, -s['bx'], -s['by']]))
            emit_range(s['start'], s['n'], mul(m, local), depth+1)

    for e in d.ents:
        if e['sect'] == 'main' and e['kind'] != 'symhdr':
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
