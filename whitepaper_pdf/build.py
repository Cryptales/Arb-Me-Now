"""Build Arb-Me-Now white paper PDF (cover + styled body) from WHITEPAPER.md."""
import re, sys, markdown
from weasyprint import HTML

SRC = '/home/ubuntu/arb_build/WHITEPAPER.md'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/home/ubuntu/arb_me_now_output/Arb-Me-Now_WhitePaper_v4.4.pdf'

md = open(SRC, encoding='utf-8').read()
# Drop the markdown title block (cover replaces it) — everything up to the first '---'
md = md.split('\n---\n', 1)[1] if '\n---\n' in md else md
md = re.sub(r'\n---\s*$', '\n', md)
md = re.sub(r'(?m)^   - ', '    - ', md)  # nested bullets need 4-space indent
body = markdown.markdown(md, extensions=['tables', 'fenced_code', 'sane_lists', 'toc'])

# Build a table of contents from the H2s
h2s = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', body)
toc = ''.join(f'<li><a href="#{i}">{t}</a></li>' for i, t in h2s)

# Cover art: a triangular arbitrage cycle (S → Y → Z → S) over a node network
cover_svg = '''
<svg viewBox="0 0 600 420" xmlns="http://www.w3.org/2000/svg" class="art">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d20058"/><stop offset="0.55" stop-color="#dd223d"/><stop offset="1" stop-color="#f56e00"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#831bfe" stop-opacity="0.45"/><stop offset="1" stop-color="#831bfe" stop-opacity="0"/>
    </radialGradient>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#e2e8f0"/>
    </marker>
  </defs>
  <circle cx="300" cy="215" r="200" fill="url(#glow)"/>
  <g stroke="#393941" stroke-width="1" opacity="0.9">
    <line x1="60" y1="60" x2="300" y2="70"/><line x1="300" y1="70" x2="540" y2="80"/>
    <line x1="60" y1="60" x2="120" y2="350"/><line x1="540" y1="80" x2="490" y2="360"/>
    <line x1="120" y1="350" x2="490" y2="360"/><line x1="40" y1="210" x2="150" y2="320"/>
    <line x1="560" y1="230" x2="460" y2="330"/><line x1="300" y1="400" x2="150" y2="320"/>
    <line x1="300" y1="400" x2="460" y2="330"/><line x1="40" y1="210" x2="60" y2="60"/>
    <line x1="560" y1="230" x2="540" y2="80"/>
  </g>
  <g fill="#4d4d56">
    <circle cx="60" cy="60" r="5"/><circle cx="540" cy="80" r="5"/><circle cx="120" cy="350" r="5"/>
    <circle cx="490" cy="360" r="5"/><circle cx="40" cy="210" r="4"/><circle cx="560" cy="230" r="4"/>
    <circle cx="300" cy="400" r="4"/>
  </g>
  <!-- the arbitrage triangle -->
  <g stroke-width="7" stroke-linecap="round" fill="none">
    <line x1="300" y1="70" x2="460" y2="330" stroke="#dd223d"/>
    <line x1="460" y1="330" x2="150" y2="320" stroke="#f56e00"/>
    <line x1="150" y1="320" x2="300" y2="70" stroke="#d20058"/>
  </g>
  <g stroke="#e2e8f0" stroke-width="2" fill="none" marker-end="url(#arr)">
    <path d="M330,125 L410,255"/><path d="M405,322 L215,316"/><path d="M175,268 L270,118"/>
  </g>
  <g font-family="DejaVu Sans Mono, monospace" font-weight="bold" text-anchor="middle">
    <circle cx="300" cy="70" r="30" fill="#18181b" stroke="#d20058" stroke-width="3"/>
    <text x="300" y="77" fill="#ff3d8b" font-size="20">S</text>
    <circle cx="460" cy="330" r="30" fill="#18181b" stroke="#f56e00" stroke-width="3"/>
    <text x="460" y="337" fill="#f97316" font-size="20">Y</text>
    <circle cx="150" cy="320" r="30" fill="#18181b" stroke="#831bfe" stroke-width="3"/>
    <text x="150" y="327" fill="#a66bff" font-size="20">Z</text>
  </g>
  <g font-family="DejaVu Sans, sans-serif" font-size="12" fill="#9091a0" text-anchor="middle">
    <text x="410" y="185">Pool A</text><text x="305" y="345">Pool B</text><text x="190" y="190">Pool C</text>
  </g>
  <text x="300" y="232" text-anchor="middle" font-family="DejaVu Sans Mono, monospace" font-size="26" font-weight="bold" fill="#f97316">+Δ</text>
</svg>'''

html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 22mm 18mm 20mm 18mm;
  @top-left {{ content: "Arb-Me-Now · Process Manual & White Paper"; font: 8pt 'DejaVu Sans'; color:#64748b; }}
  @top-right {{ content: "v4.9 · November 2026"; font: 8pt 'DejaVu Sans'; color:#64748b; }}
  @bottom-center {{ content: counter(page) " / " counter(pages); font: 8pt 'DejaVu Sans'; color:#64748b; }}
  @bottom-left {{ content: "cryptales.github.io/Arb-Me-Now"; font: 7.5pt 'DejaVu Sans Mono'; color:#94a3b8; }}
}}
@page cover {{ margin: 0; @top-left {{content:none}} @top-right {{content:none}} @bottom-center {{content:none}} @bottom-left {{content:none}} }}
@page toc {{ @bottom-center {{content:none}} }}
html, body {{ margin:0; padding:0; }}
html {{ font-family: 'DejaVu Sans', sans-serif; font-size: 9.6pt; color:#1e293b; line-height:1.5; }}
.cover {{ page: cover; width:210mm; height:297mm; box-sizing:border-box; padding:24mm 20mm 18mm;
  background-color:#0a0a0a; background-image: radial-gradient(ellipse 120mm 90mm at 100% 100%, rgba(131,27,254,0.55), rgba(210,0,88,0.25) 45%, rgba(10,10,10,0) 75%), radial-gradient(ellipse 80mm 60mm at 0% 0%, rgba(249,115,22,0.18), rgba(10,10,10,0) 70%); color:#ededed; position:relative; }}
.cover .bar {{ height:5px; width:60mm; background: linear-gradient(90deg,#d20058,#dd223d,#f56e00); border-radius:3px; }}
.cover .kicker {{ margin-top:8mm; font: bold 9pt 'DejaVu Sans Mono'; letter-spacing:3px; color:#f97316; text-transform:uppercase; }}
.cover h1 {{ font-size:46pt; line-height:1.0; margin:4mm 0 3mm; color:#fff; letter-spacing:-1px; }}
.cover h1 span {{ color:#f97316; }}
.cover .sub {{ font-size:15pt; color:#ededed; margin:0; }}
.cover .sub2 {{ font-size:10.5pt; color:#9091a0; margin-top:3mm; }}
.cover .art {{ width:150mm; display:block; margin: 12mm auto 8mm; }}
.cover .chips {{ text-align:center; }}
.cover .chip {{ display:inline-block; border:1px solid #f97316; border-radius:20px; padding:2mm 4mm; margin:1mm; font: 8pt 'DejaVu Sans Mono'; color:#ededed; background:#18181b; }}
.cover .foot {{ position:absolute; left:20mm; right:20mm; bottom:16mm; border-top:1px solid #393941; padding-top:4mm; font-size:8.5pt; color:#9091a0; }}
.cover .foot b {{ color:#ffffff; }}
.cover .foot .r {{ float:right; font-family:'DejaVu Sans Mono'; color:#f97316; }}
.tocpage {{ page: toc; break-after: page; }}
.tocpage h2 {{ border:none; }}
.tocpage ol {{ font-size:11pt; line-height:2.1; padding-left:6mm; }}
.tocpage a {{ color:#0f172a; text-decoration:none; }}
.tocpage a::after {{ content: leader('.') target-counter(attr(href), page); color:#64748b; }}
.note {{ margin-top:10mm; padding:4mm 5mm; border-left:4px solid #f97316; background:#fff7ed; font-size:9pt; color:#475569; border-radius:0 6px 6px 0; }}
h2 {{ font-size:15pt; color:#0b1220; margin:9mm 0 3mm; padding-bottom:2mm; border-bottom:2px solid transparent;
  border-image: linear-gradient(90deg,#d20058,#dd223d,#f56e00) 1; break-after: avoid; }}
h3 {{ font-size:11.5pt; color:#c2410c; margin:5mm 0 2mm; break-after: avoid; }}
h2:first-of-type {{ margin-top:0; }}
p, li {{ orphans:3; widows:3; }}
a {{ color:#d20058; }}
code {{ font-family:'DejaVu Sans Mono'; font-size:8.2pt; background:#f4f4f5; color:#c2410c; padding:0.3mm 1mm; border-radius:3px; word-break: break-all; }}
table {{ width:100%; border-collapse:collapse; margin:3mm 0 4mm; font-size:8.6pt; break-inside:auto; }}
thead {{ display: table-header-group; }}
tr {{ break-inside: avoid; }}
th {{ background:#18181b; color:#ededed; border-bottom:2px solid #f97316; text-align:left; padding:2mm 2.5mm; font-weight:bold; }}
td {{ padding:1.8mm 2.5mm; border-bottom:1px solid #e2e8f0; vertical-align:top; }}
tbody tr:nth-child(even) td {{ background:#f8fafc; }}
strong {{ color:#0b1220; }}
ul, ol {{ padding-left:6mm; }}
li {{ margin:0.8mm 0; }}
</style></head><body>
<section class="cover">
  <div class="bar"></div>
  <div class="kicker">PulseChain · On-chain Arbitrage Scanner</div>
  <h1>Arb-Me-<span>Now</span></h1>
  <p class="sub">Process Manual &amp; White Paper</p>
  <p class="sub2">Methodology, operating procedure, verified parameters and risk model</p>
  {cover_svg}
  <div class="chips">
    <span class="chip">PulseX v1 · v2</span><span class="chip">9mm v2</span><span class="chip">LibertySwap V3</span>
    <span class="chip">2-pool + triangular</span><span class="chip">BigInt engine</span><span class="chip">read-only</span>
  </div>
  <div class="foot"><span class="r">cryptales.github.io/Arb-Me-Now</span><b>Version 4.9</b> · November 2026 · Analysis tool, not financial advice</div>
</section>
<section class="tocpage">
  <h2>Contents</h2>
  <ol>{toc}</ol>
  <div class="note"><b>At a glance.</b> Arb-Me-Now reads every pool from one PulseChain block, models each swap with exact integer maths, finds the optimal size for 2-pool and triangular routes, and reports profit before and after estimated gas. It never connects a wallet or sends a transaction.</div>
</section>
{body}
</body></html>'''

# strip "1. " numbering in TOC labels since <ol> numbers them
html = re.sub(r'(<li><a href="#[^"]+">)\d+\.\s*', r'\1', html)
HTML(string=html, base_url='/home/ubuntu/arb_build').write_pdf(OUT)
print('wrote', OUT)
