import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc
import render2
from PIL import Image, ImageDraw

def arcpts_dir(x,y,rx,ry,a1,a2,rot,cw):
    if cw:
        sweep = -((a1 - a2) % (2*math.pi))
        if abs(a2-a1) <= 1e-12: sweep = -2*math.pi
    else:
        sweep = (a2 - a1) % (2*math.pi)
        if abs(a2-a1) <= 1e-12: sweep = 2*math.pi
    n = max(8, int(abs(sweep)/0.08)); c,s = math.cos(rot), math.sin(rot); out=[]
    for k in range(n+1):
        a = a1 + sweep*k/n
        px,py = rx*math.cos(a), ry*math.sin(a)
        out.append((x+px*c-py*s, y+px*s+py*c))
    return out

def geom(d, cw):
    render2.arcpts = lambda x,y,rx,ry,a1,a2,rot: arcpts_dir(x,y,rx,ry,a1,a2,rot,cw)
    return render2.geom(d)

name = sys.argv[1]; W=900
d = Doc(os.path.join('samples', name))
ims=[]
for cw in (False, True):
    segs = geom(d, cw)
    xs=[q[0] for s_ in segs for q in s_]; ys=[q[1] for s_ in segs for q in s_]
    x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
    if len(sys.argv)>2: x0,y0,x1,y1 = map(float, sys.argv[2:6])
    sc=(W-20)/max(x1-x0,1e-9); H=max(50,int((y1-y0)*sc))+20
    im=Image.new('RGB',(W,H),'white'); dr=ImageDraw.Draw(im)
    for a,b in segs:
        dr.line([(10+(a[0]-x0)*sc, H-10-(a[1]-y0)*sc),(10+(b[0]-x0)*sc, H-10-(b[1]-y0)*sc)],fill='black')
    dr.text((12,4), 'CW' if cw else 'CCW', fill=(200,0,0))
    ims.append(im)
h=max(i.height for i in ims)
out=Image.new('RGB',(W*2+8, h),'#888888')
out.paste(ims[0],(0,0)); out.paste(ims[1],(W+8,0))
p=os.environ['SP']+'/dir_'+name.replace('.2D','')+'.png'; out.save(p); print(p)
