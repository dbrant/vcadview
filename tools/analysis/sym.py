import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
from parse import Doc

def hexdump(r, label):
    print(f'  [{label}]')
    for j in range(0, 128, 16):
        h = ' '.join(f'{x:02x}' for x in r[j:j+16])
        a = ''.join(chr(x) if 32 <= x < 127 else '.' for x in r[j:j+16])
        v = f64(r, j)
        ex = f'  d={v:.6g}' if plausible(v) and v != 0 else ''
        print(f'    {j:03x} {h} |{a}|{ex}')

d = Doc(os.path.join(os.path.dirname(samples()[0]), 'MAN.2D'))
print('=== MAN.2D  type8 (insert) records')
for e in d.ents:
    if e['kind'] == 'type8': hexdump(e['raw'], f"rec{e['rec']} sub=0x{e['sub']:02x}")
print('=== symbol table records (0x58)')
for i, r in enumerate(d.sym_recs): hexdump(r, f'sym{i}')
print('=== symhdr records (0x66)')
for e in d.ents:
    if e['kind'] == 'symhdr': hexdump(e['raw'], f"rec{e['rec']}")
