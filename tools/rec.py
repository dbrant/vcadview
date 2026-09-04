"""Shared helpers for VersaCAD .2D reverse engineering."""
import struct, glob, os

REC = 128

def records(path):
    d = open(path, 'rb').read()
    return [d[i:i+REC] for i in range(0, len(d) - len(d) % REC, REC)]

def f64(b, o):
    if o + 8 > len(b): return None
    return struct.unpack_from('<d', b, o)[0]

def u16(b, o): return struct.unpack_from('<H', b, o)[0]
def i16(b, o): return struct.unpack_from('<h', b, o)[0]
def u32(b, o): return struct.unpack_from('<I', b, o)[0]

def plausible(v):
    """Is this a plausible CAD coordinate/parameter double?"""
    if v is None: return False
    if v != v: return False          # NaN
    if v in (0.0,): return True
    a = abs(v)
    return 1e-6 < a < 1e7

def samples():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return sorted(glob.glob(os.path.join(here, 'samples', '*.2D')))
