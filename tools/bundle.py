"""Inline web/js/*.js into web/index.html to produce one self-contained file.

    python tools/bundle.py [output.html]

The result opens straight from disk (file://) with no server and no network.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')

SCRIPT_RE = re.compile(r'[ \t]*<script src="([^"]+)"></script>\n?')


def build():
    html = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()

    def repl(m):
        path = os.path.join(WEB, m.group(1).replace('/', os.sep))
        code = open(path, encoding='utf-8').read()
        # Guard against a stray closing tag inside a string literal.
        code = code.replace('</script>', '<\\/script>')
        return ('<script>\n/* ==== ' + m.group(1) + ' ==== */\n'
                + code.rstrip() + '\n</script>\n')

    out, n = SCRIPT_RE.subn(repl, html)
    if n == 0:
        raise SystemExit('no <script src=...> tags found in web/index.html')
    return out, n


if __name__ == '__main__':
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'vcadview.html')
    text, n = build()
    with open(dest, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print(f'{dest}  ({len(text):,} bytes, {n} scripts inlined)')
