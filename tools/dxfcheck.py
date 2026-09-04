"""Round-trip check: read the exported DXF back, compare its geometry with the
reference display list, and render it to PNG so it can be eyeballed.

Usage:  python tools/dxfcheck.py EXPORTDIR PNGDIR
"""
import sys, os, math, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import samples
from parse import Doc
import dump_prims as DP
from PIL import Image, ImageDraw


def read_dxf(path):
    """Minimal group-code reader -> (blocks, entities)."""
    with open(path, 'r', encoding='latin1', newline='') as fh:
        raw = fh.read().split('\n')
    toks = [t.strip('\r') for t in raw]
    pairs = []
    i = 0
    while i + 1 < len(toks):
        code = toks[i].strip()
        if code == '':
            i += 1
            continue
        pairs.append((int(code), toks[i + 1]))
        i += 2
    return pairs


def group_entities(pairs, start, stop_marker):
    """Split a run of pairs into entity dicts keyed by group code."""
    ents, cur = [], None
    for code, val in pairs[start:]:
        if code == 0:
            if val == stop_marker:
                break
            if cur is not None:
                ents.append(cur)
            cur = {'type': val, 'g': collections.defaultdict(list)}
        elif cur is not None:
            cur['g'][code].append(val)
    if cur is not None:
        ents.append(cur)
    return ents


def parse_dxf(path):
    pairs = read_dxf(path)
    # locate sections
    idx = {}
    for i, (c, v) in enumerate(pairs):
        if c == 0 and v == 'SECTION':
            idx[pairs[i + 1][1]] = i + 2
    blocks, ents = {}, []

    # BLOCKS
    if 'BLOCKS' in idx:
        cur_name, cur_list, base = None, None, (0.0, 0.0)
        i = idx['BLOCKS']
        while i < len(pairs):
            c, v = pairs[i]
            if c == 0 and v == 'ENDSEC':
                break
            if c == 0 and v == 'BLOCK':
                g = collections.defaultdict(list)
                j = i + 1
                while j < len(pairs) and pairs[j][0] != 0:
                    g[pairs[j][0]].append(pairs[j][1]); j += 1
                cur_name = g[2][0]
                base = (float(g[10][0]), float(g[20][0]))
                cur_list = []
                blocks[cur_name] = {'base': base, 'ents': cur_list}
                i = j
                continue
            if c == 0 and v == 'ENDBLK':
                cur_name, cur_list = None, None
                i += 1
                continue
            if c == 0 and cur_list is not None:
                e = {'type': v, 'g': collections.defaultdict(list)}
                j = i + 1
                while j < len(pairs) and pairs[j][0] != 0:
                    e['g'][pairs[j][0]].append(pairs[j][1]); j += 1
                if v == 'VERTEX' and cur_list and cur_list[-1]['type'] == 'POLYLINE':
                    cur_list[-1].setdefault('verts', []).append(e)
                elif v == 'SEQEND':
                    pass
                else:
                    cur_list.append(e)
                i = j
                continue
            i += 1

    # ENTITIES
    if 'ENTITIES' in idx:
        i = idx['ENTITIES']
        while i < len(pairs):
            c, v = pairs[i]
            if c == 0 and v == 'ENDSEC':
                break
            if c == 0:
                e = {'type': v, 'g': collections.defaultdict(list)}
                j = i + 1
                while j < len(pairs) and pairs[j][0] != 0:
                    e['g'][pairs[j][0]].append(pairs[j][1]); j += 1
                if v == 'VERTEX' and ents and ents[-1]['type'] == 'POLYLINE':
                    ents[-1].setdefault('verts', []).append(e)
                elif v == 'SEQEND':
                    pass
                else:
                    ents.append(e)
                i = j
                continue
            i += 1
    return blocks, ents


def f(e, code, default=0.0):
    v = e['g'].get(code)
    return float(v[0]) if v else default


def emit_dxf(ents, blocks, m, out, texts, depth=0):
    if depth > 12:
        return
    for e in ents:
        t = e['type']
        if t == 'LINE':
            a = DP.ap(m, f(e, 10), f(e, 20))
            b = DP.ap(m, f(e, 11), f(e, 21))
            out.append([a, b])
        elif t in ('ARC', 'CIRCLE'):
            cx, cy, r = f(e, 10), f(e, 20), f(e, 40)
            a1 = math.radians(f(e, 50, 0.0)) if t == 'ARC' else 0.0
            a2 = math.radians(f(e, 51, 360.0)) if t == 'ARC' else 2 * math.pi
            sweep = a2 - a1
            if sweep <= 1e-12:
                sweep += 2 * math.pi
            n = max(8, int(abs(sweep) / 0.05))
            pts = []
            for k in range(n + 1):
                a = a1 + sweep * k / n
                pts.append(DP.ap(m, cx + r * math.cos(a), cy + r * math.sin(a)))
            out.append(pts)
        elif t == 'POLYLINE':
            pts = [DP.ap(m, f(v, 10), f(v, 20)) for v in e.get('verts', [])]
            if int(f(e, 70, 0)) & 1 and pts:
                pts.append(pts[0])
            if len(pts) > 1:
                out.append(pts)
        elif t == 'TEXT':
            p = DP.ap(m, f(e, 10), f(e, 20))
            texts.append((p, e['g'].get(1, [''])[0], f(e, 40), f(e, 41, 1.0)))
        elif t == 'INSERT':
            name = e['g'][2][0]
            blk = blocks.get(name)
            if not blk:
                continue
            ix, iy = f(e, 10), f(e, 20)
            sx, sy = f(e, 41, 1.0), f(e, 42, 1.0)
            rot = math.radians(f(e, 50, 0.0))
            cr, sr = math.cos(rot), math.sin(rot)
            local = DP.mul([cr, sr, -sr, cr, ix, iy],
                           DP.mul([sx, 0, 0, sy, 0, 0],
                                  [1, 0, 0, 1, -blk['base'][0], -blk['base'][1]]))
            emit_dxf(blk['ents'], blocks, DP.mul(m, local), out, texts, depth + 1)


def polylen(paths):
    tot = 0.0
    for p in paths:
        for a, b in zip(p, p[1:]):
            tot += math.hypot(b[0] - a[0], b[1] - a[1])
    return tot


def ref_paths(d):
    """Reference geometry from the .2D file, as polylines."""
    out, texts = [], []
    for t in DP.flatten(d):
        if t[0] == 'l':
            out.append([(t[1], t[2]), (t[3], t[4])])
        elif t[0] == 'a':
            cx, cy, ux, uy, vx, vy, a1, a2 = t[1:9]
            sweep = a2 - a1
            n = max(8, int(abs(sweep) / 0.05))
            pts = []
            for k in range(n + 1):
                a = a1 + sweep * k / n
                pts.append((cx + ux * math.cos(a) + vx * math.sin(a),
                            cy + uy * math.cos(a) + vy * math.sin(a)))
            out.append(pts)
        elif t[0] == 'b':
            q = t[1:9]
            pts = []
            for k in range(33):
                s = k / 32.0
                u = 1 - s
                pts.append((u**3*q[0] + 3*u*u*s*q[2] + 3*u*s*s*q[4] + s**3*q[6],
                            u**3*q[1] + 3*u*u*s*q[3] + 3*u*s*s*q[5] + s**3*q[7]))
            out.append(pts)
        elif t[0] == 't':
            texts.append(((t[1], t[2]), t[8], t[3], t[4]))
    return out, texts


def bbox(paths):
    xs = [p[0] for pa in paths for p in pa]
    ys = [p[1] for pa in paths for p in pa]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def render(paths, out, W=1400):
    bb = bbox(paths)
    if not bb:
        return
    x0, y0, x1, y1 = bb
    w, h = max(x1 - x0, 1e-9), max(y1 - y0, 1e-9)
    sc = (W - 20) / w
    H = max(50, int(h * sc)) + 20
    im = Image.new('RGB', (W, H), 'white')
    dr = ImageDraw.Draw(im)
    for p in paths:
        for a, b in zip(p, p[1:]):
            dr.line([(10 + (a[0]-x0)*sc, H-10-(a[1]-y0)*sc),
                     (10 + (b[0]-x0)*sc, H-10-(b[1]-y0)*sc)], fill='black')
    im.save(out)


if __name__ == '__main__':
    expdir, pngdir = sys.argv[1], sys.argv[2]
    os.makedirs(pngdir, exist_ok=True)
    print(f'{"file":13s} {"ref len":>12s} {"dxf len":>12s} {"d%":>7s} '
          f'{"ref txt":>8s} {"dxf txt":>8s} {"bbox dev":>9s}')
    worst = 0.0
    for p in samples():
        base = os.path.basename(p)[:-3]
        d = Doc(p)
        rp, rt = ref_paths(d)
        blocks, ents = parse_dxf(os.path.join(expdir, base + '.dxf'))
        dp, dt = [], []
        emit_dxf(ents, blocks, [1, 0, 0, 1, 0, 0], dp, dt)
        rl, dl = polylen(rp), polylen(dp)
        dev = abs(dl - rl) / rl * 100 if rl else 0
        rb, db = bbox(rp), bbox(dp)
        bdev = max(abs(a - b) for a, b in zip(rb, db)) if rb and db else -1
        worst = max(worst, dev)
        # do the strings survive?
        rs = sorted(x[1] for x in rt)
        ds = sorted(x[1] for x in dt)
        print(f'{base:13s} {rl:12.2f} {dl:12.2f} {dev:6.3f}% {len(rt):8d} {len(dt):8d} '
              f'{bdev:9.5f} {"TEXT-OK" if rs == ds else "TEXT-DIFF"}')
        render(dp, os.path.join(pngdir, base + '.png'))
    print(f'\nworst path-length deviation: {worst:.3f}%')
