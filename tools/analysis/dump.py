import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *

def show(path, lo, hi, doubles=True):
    rs = records(path)
    for i in range(lo, min(hi, len(rs))):
        b = rs[i]
        print(f'--- {os.path.basename(path)} rec {i} tag={b[0]:02x},{b[1]:02x}')
        for j in range(0, 128, 16):
            h = ' '.join(f'{x:02x}' for x in b[j:j+16])
            a = ''.join(chr(x) if 32 <= x < 127 else '.' for x in b[j:j+16])
            extra = ''
            if doubles:
                v = f64(b, j)
                if plausible(v) and v != 0.0: extra = f'  d@{j:02x}={v:.6g}'
            print(f'  {j:03x}  {h}  |{a}|{extra}')

if __name__ == '__main__':
    p = sys.argv[1]
    if not os.path.exists(p):
        p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'samples', p)
    show(p, int(sys.argv[2]), int(sys.argv[3]))
