import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
from render2 import build, geom, arcpts
from PIL import Image, ImageDraw

p = os.path.join(os.path.dirname(samples()[0]), sys.argv[1])
d = Doc(p)
segs = geom(d)
boxes = []
for e in d.ents:
    if e['kind'] != 'text' or not e['text']: continue
    w = len(e['text']) * e['w']; h = e['h']; rot = f64(e['raw'], 0x3c)
    if abs(rot - 2*math.pi) < 1e-6: rot = 0.0
    c, s = math.cos(rot), math.sin(rot)
    pts = [(0,0), (w,0), (w,h), (0,h), (0,0)]
    pts = [(e['x']+px*c-py*s, e['y']+px*s+py*c) for px, py in pts]
    boxes.extend(zip(pts, pts[1:]))

xs=[q[0] for s_ in segs for q in s_]; ys=[q[1] for s_ in segs for q in s_]
x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
# crop to the requested window
if len(sys.argv) > 2:
    cx0,cy0,cx1,cy1 = map(float, sys.argv[2:6]); x0,y0,x1,y1 = cx0,cy0,cx1,cy1
W=1500; sc=(W-20)/max(x1-x0,1e-9); H=int((y1-y0)*sc)+20
im=Image.new('RGB',(W,H),'white'); dr=ImageDraw.Draw(im)
def T(q): return (10+(q[0]-x0)*sc, H-10-(q[1]-y0)*sc)
for a,b in segs: dr.line([T(a),T(b)],fill='black')
for a,b in boxes: dr.line([T(a),T(b)],fill=(255,0,0))
out=os.environ['SP']+'/tbox.png'; im.save(out); print(out, 'boxes=',len(boxes))
