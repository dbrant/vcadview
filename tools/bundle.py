"""Build the distributable app from web/ into dist/.

    python tools/bundle.py [outdir]

The six source scripts are concatenated into one vcadview.js and the
stylesheets into one vcadview.css, so a deployment is three files rather than
eight. Markup, styling and behaviour stay in separate files.

The result opens straight from disk (file://) with no server and no network:
plain <link> and classic <script> tags both work from a file URL.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')

SCRIPT_RE = re.compile(r'[ \t]*<script src="([^"]+)"></script>[ \t]*\n?')
LINK_RE = re.compile(r'[ \t]*<link rel="stylesheet" href="([^"]+)"[^>]*>[ \t]*\n?')

JS_NAME = 'vcadview.js'
CSS_NAME = 'vcadview.css'
HTML_NAME = 'vcadview.html'


def _read(rel):
    return open(os.path.join(WEB, rel.replace('/', os.sep)), encoding='utf-8').read()


def _concat(paths, kind):
    parts = []
    for p in paths:
        body = _read(p).rstrip()
        if kind == 'js':
            # A closing tag inside a string literal would end the <script> that
            # loads this file if anyone ever inlines it again.
            body = body.replace('</script>', '<\\/script>')
        parts.append('/* ==== %s ==== */\n%s\n' % (p, body))
    return '\n'.join(parts)


def build():
    """Return (html, css, js, sources) without writing anything."""
    html = _read('index.html')

    scripts = SCRIPT_RE.findall(html)
    styles = LINK_RE.findall(html)
    if not scripts:
        raise SystemExit('no <script src=...> tags found in web/index.html')
    if not styles:
        raise SystemExit('no <link rel="stylesheet"> found in web/index.html')

    js = _concat(scripts, 'js')
    css = _concat(styles, 'css')

    # Collapse each run of tags down to a single reference.
    html = LINK_RE.sub('', html, count=len(styles))
    html = html.replace('</title>',
                        '</title>\n<link rel="stylesheet" href="%s">' % CSS_NAME, 1)
    html = SCRIPT_RE.sub('', html, count=len(scripts))
    html = html.replace('</body>', '<script src="%s"></script>\n</body>' % JS_NAME, 1)

    return html, css, js, {'scripts': scripts, 'styles': styles}


def write(outdir):
    html, css, js, src = build()
    os.makedirs(outdir, exist_ok=True)
    files = []
    for name, text in ((HTML_NAME, html), (CSS_NAME, css), (JS_NAME, js)):
        path = os.path.join(outdir, name)
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
        files.append((path, len(text)))
    return files, src


if __name__ == '__main__':
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist')
    files, src = write(dest)
    for path, size in files:
        print(f'{os.path.relpath(path, ROOT)}  ({size:,} bytes)')
    print(f'{len(src["styles"])} stylesheet(s) and {len(src["scripts"])} script(s) combined')
