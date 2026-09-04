import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
n = 0
for p in samples():
    got = 0
    for i, r in enumerate(records(p)[7:], 7):
        if r[1] != 0x64 or (r[0x4e] & 0xf) != 4: continue
        got += 1
        if got > 3: break
        s = r[0x62:].split(b'\0')[0].decode('latin1')
        print(f'{os.path.basename(p):12s} rec{i:5d} st=0x{r[0x4e]:02x} attr={r[2:8].hex()}')
        print(f'   x={f64(r,0x1c):.4f} y={f64(r,0x24):.4f}')
        print(f'   40..63: {r[0x40:0x64].hex(" ")}')
        for o in (0x50, 0x58, 0x60):
            print(f'   d@{o:02x}={f64(r,o):<14.6g} f32@{o:02x}={struct.unpack_from("<f",r,o)[0]:<12.6g} f32@{o+4:02x}={struct.unpack_from("<f",r,o+4)[0]:.6g}')
        print(f'   str={s!r}')
