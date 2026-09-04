import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rec import *
for p in samples():
    r = records(p)[0]
    print(f'{os.path.basename(p):14s} {r[0:32].hex(" ")}')
print()
print('record 5 (0x30) first 32 bytes:')
for p in samples():
    r = records(p)[5]
    print(f'{os.path.basename(p):14s} {r[0:40].hex(" ")}')
