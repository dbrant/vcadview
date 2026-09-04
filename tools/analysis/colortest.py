import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
import render2
from PIL import Image, ImageDraw

PAL = [(0,0,0),(220,0,0),(0,150,0),(0,80,255),(220,140,0),(180,0,200),(0,170,170),(120,90,40),(255,0,255)]
p = os.path.join(os.path.dirname(samples()[0]), sys.argv[1])
byteoff = int(sys.argv[2], 0)
d = Doc(p)
syms, byrec = render2.build(d)
segs = []
def collect(lo, hi, M, key, depth=0):
    if depth > 8: return
    i = lo
    while i < hi:
        e = byrec.get(i)
        if e is None: i += 1; continue
        i += 1
        if e.get('cont'): i += 1
        k = e['kind']; kk = key if key is not None else e['raw'][byteoff]
        if k == 'line':
            segs.append((M(e['x'],e['y']), M(e['x']+e['dx'],e['y']+e['dy']), kk))
        elif k == 'arc':
            pts=[M(*q) for q in render2.arcpts(e['x'],e['y'],e['rx'],e['ry'],e['a1'],e['a2'],e['rot'])]
            for a,b in zip(pts,pts[1:]): segs.append((a,b,kk))
        elif k == 'type8':
            r=e['raw']; g=r[0x50:0x59].split(b'\0')[0].decode('latin1')
            s=syms.get((g,u16(r,0x59)>>1))
            if not s: continue
            ix,iy=f64(r,0x1c),f64(r,0x24); rot=f64(r,0x3c); sx=f64(r,0x6b); sy=f64(r,0x73)
            co,si=math.cos(rot),math.sin(rot); bx,by=s['bx'],s['by']
            def M2(px,py,_M=M,bx=bx,by=by,sx=sx,sy=sy,co=co,si=si,ix=ix,iy=iy):
                ux,uy=(px-bx)*sx,(py-by)*sy
                return _M(ix+ux*co-uy*si, iy+ux*si+uy*co)
            collect(s['start'], s['start']+s['n'], M2, kk, depth+1)
collect(d.ent_start, d.ent_start+d.n_part1, lambda x,y:(x,y), None)
xs=[q[i] for s_ in segs for q in s_[:2] for i in (0,)]; ys=[q[1] for s_ in segs for q in s_[:2]]
x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
W=1500; sc=(W-20)/(x1-x0); H=int((y1-y0)*sc)+20
im=Image.new('RGB',(W,H),'white'); dr=ImageDraw.Draw(im)
def T(q): return (10+(q[0]-x0)*sc, H-10-(q[1]-y0)*sc)
import collections
cnt=collections.Counter()
for a,b,k in segs:
    cnt[k]+=1
    dr.line([T(a),T(b)],fill=PAL[k % len(PAL)])
out=os.environ['SP']+f'/color_{byteoff:02x}.png'; im.save(out)
print(out, 'value->segcount', dict(sorted(cnt.items())))
print('palette:', {i:PAL[i%len(PAL)] for i in sorted(cnt)})
