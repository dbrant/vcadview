"""Prototype VersaCAD .2D parser."""
import sys, os, struct, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import *
import math


def signed_angle(a):
    """Fold into (-pi, pi]; mirrors signedAngle in web/js/vcad-parse.js."""
    tau = 2 * math.pi
    a = a % tau
    if a > math.pi:
        a -= tau
    if a <= -math.pi:
        a += tau
    return a


class Doc:
    def __init__(self, path):
        self.path = path
        self.rs = records(path)
        h = self.rs[0]
        self.version   = u16(h, 0x02)
        self.ent_start = u16(h, 0x04)
        self.n_part1   = u16(h, 0x06)
        self.n_sym     = u16(h, 0x08)
        self.n_part2   = u16(h, 0x0a)
        self.ents = []
        self.warn = collections.Counter()
        self._walk(self.ent_start, self.n_part1, 'main')
        s2 = self.ent_start + self.n_part1
        self.sym_recs = self.rs[s2:s2+self.n_sym]
        s3 = s2 + self.n_sym
        self._walk(s3, self.n_part2, 'sym')
        self.end = s3 + self.n_part2
        hs = sorted(e['h'] for e in self.ents
                    if e['kind'] == 'text' and e.get('h', 0) > 0)
        self.text_height = hs[len(hs)//2] if hs else 0.0
        byrec = {e['rec']: e for e in self.ents}
        for e in self.ents:
            if e['kind'] in ('dim', 'angdim'):
                lab = byrec.get(e['rec'] + 1)
                if lab is not None and lab['kind'] == 'text':
                    e['label'] = lab

    def _walk(self, start, count, sect):
        i = start
        stop = start + count
        while i < stop:
            r = self.rs[i]
            t = r[1]
            # The low two bits of the entity tag are flags (0x66 = first
            # record of a symbol body, 0x65 = unidentified); the record is an
            # ordinary entity in every case. Only observed tags are accepted so
            # that a lost walk still reports rather than drawing nonsense.
            if t not in (0x64, 0x65, 0x66):
                self.warn[f'{sect}:unexpected tag {t:02x}'] += 1
                i += 1; continue
            e = self._entity(r, i, sect)
            i += 1
            if e.get('cont'):
                if i < stop:
                    e['text'] = self.rs[i][2:2+e['clen']].decode('latin1')
                    i += 1
            self.ents.append(e)

    def _entity(self, r, i, sect):
        st = r[0x4e]
        e = dict(rec=i, sect=sect, sub=st, type=st & 0x0f, hi=st >> 4,
                 flags=r[0], attr=r[2:8],
                 layer=r[0x44:0x4b].split(b'\0')[0].decode('latin1'),
                 x=f64(r, 0x1c), y=f64(r, 0x24), raw=r)
        t = e['type']
        if t == 1:
            e['kind'] = 'line'; e['dx'] = f64(r, 0x50); e['dy'] = f64(r, 0x58)
        elif t == 2:
            e['kind'] = 'rect'
            e['dx'] = f64(r, 0x50); e['dy'] = f64(r, 0x58)
        elif t == 3:
            e['kind'] = 'arc'
            e['rx'] = f64(r, 0x50); e['ry'] = f64(r, 0x58)
            e['a1'] = f64(r, 0x60); e['a2'] = f64(r, 0x68)
            e['cw'] = bool(r[0x73] & 0x40)      # sweep direction
            e['rot'] = f64(r, 0x3c)
        elif t == 5:
            e['kind'] = 'dim'
            e['dx'] = f64(r, 0x50); e['dy'] = f64(r, 0x58)
            e['offset'] = f64(r, 0x60)
            e['gapHalf'] = f64(r, 0x68)
            e['gapMid'] = f64(r, 0x70)
            e['horiz'] = (r[0x79] & 0x40) == 0
        elif t == 7:
            e['kind'] = 'arrow'
            v = f64(r, 0x3c)                      # same clamp as the JS reader
            e['a0'] = v if (v == v and -7 <= v <= 7) else 0.0
        elif t == 9:
            e['kind'] = 'angdim'
            e['a0'] = f64(r, 0x3c)
            e['r0'] = f64(r, 0x68)
            e['rArc'] = e['r0'] + f64(r, 0x60)
            e['sweep'] = signed_angle(struct.unpack_from('<f', r, 0x70)[0])
            e['gapHalf'] = abs(struct.unpack_from('<f', r, 0x74)[0])
            e['gapMid'] = signed_angle(struct.unpack_from('<f', r, 0x78)[0])
        elif t == 4:
            e['kind'] = 'text'
            if self.version <= 0x36:
                e['w'] = f64(r, 0x50); e['h'] = f64(r, 0x58)
            else:
                e['w'] = struct.unpack_from('<f', r, 0x50)[0]
                e['h'] = struct.unpack_from('<f', r, 0x58)[0]
            e['font'] = r[0x60]
            L = r[0x61]
            if L & 0x80:
                e['cont'] = True; e['clen'] = L & 0x7f; e['text'] = ''
            else:
                e['text'] = r[0x62:0x62+L].decode('latin1')
        else:
            e['kind'] = f'type{t}'
        return e

if __name__ == '__main__':
    for p in samples():
        d = Doc(p)
        pad = d.rs[d.end:]
        padok = all(all(b == 0 for b in r) for r in pad)
        k = collections.Counter(e['kind'] for e in d.ents)
        print(f'{os.path.basename(p):14s} v={d.version:02x} start={d.ent_start:5d} p1={d.n_part1:5d} '
              f'sym={d.n_sym:3d} p2={d.n_part2:5d} end={d.end:5d}/{len(d.rs):5d} padZero={padok}')
        print(f'   {dict(k)}')
        if d.warn: print(f'   WARN {dict(d.warn)}')
