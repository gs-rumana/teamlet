#!/usr/bin/env python3
"""Generates the Teamlet logo variants (SVG) and an HTML preview sheet.

Run:  python3 design/logo/generate.py
Then render previews with headless Chrome (see render.sh).

Each variant is described once as a list of (role, element) pairs, where the
element string contains a `{c}` placeholder for its paint. Roles are `lead`,
`w1`, `w2`, `w3`. From that single description we emit:
  - teamlet-<slug>-mark.svg : the bare mark, painted with currentColor
  - teamlet-<slug>-icon.svg : 64px rounded gradient tile with a white mark
"""
from pathlib import Path

HERE = Path(__file__).parent
STROKE = 'fill="none" stroke="{c}" stroke-linecap="round" stroke-linejoin="round"'

VARIANTS = [
    {
        "slug": "fork",
        "name": "Fork",
        "concept": "The lead splits one task into three parallel lanes. Delegation drawn as flow rather than as an org chart.",
        "elements": [
            ("w1", f'<path d="M22 32c10 0 10-16 20-16h12" {STROKE} stroke-width="6"/>'),
            ("w2", f'<path d="M22 32h32" {STROKE} stroke-width="6"/>'),
            ("w3", f'<path d="M22 32c10 0 10 16 20 16h12" {STROKE} stroke-width="6"/>'),
            ("lead", f'<path d="M12 32h11" {STROKE} stroke-width="6"/><circle cx="12" cy="32" r="6.5" fill="{{c}}"/>'),
        ],
    },
    {
        "slug": "loop",
        "name": "Loop",
        "concept": "Fork and join: the lead splits the work, three lanes run in parallel, and the results merge back into one summary.",
        "elements": [
            ("w1", f'<path d="M15 32c7 0 7-16 14-16h6c7 0 7 16 14 16" {STROKE} stroke-width="5"/>'),
            ("w2", f'<path d="M15 32h34" {STROKE} stroke-width="5"/>'),
            ("w3", f'<path d="M15 32c7 0 7 16 14 16h6c7 0 7-16 14-16" {STROKE} stroke-width="5"/>'),
            ("lead", f'<path d="M7 32h8M49 32h8" {STROKE} stroke-width="5"/>'),
        ],
    },
    {
        "slug": "tee",
        "name": "Tee",
        "concept": "A T monogram. The crossbar is the lead holding the task; three lanes hang from it, the middle one forming the stem.",
        "elements": [
            ("w1", f'<path d="M18 15v22" {STROKE} stroke-width="7"/>'),
            ("w2", f'<path d="M32 15v37" {STROKE} stroke-width="7"/>'),
            ("w3", f'<path d="M46 15v22" {STROKE} stroke-width="7"/>'),
            ("lead", f'<path d="M10 15h44" {STROKE} stroke-width="7"/>'),
        ],
    },
    {
        "slug": "prompt",
        "name": "Prompt",
        "concept": "A terminal prompt followed by three parallel streams. Nods to the CLIs Teamlet drives: one prompt, several agents.",
        "elements": [
            ("lead", f'<path d="M11 18l13 14-13 14" {STROKE} stroke-width="6"/>'),
            ("w1", f'<path d="M34 19h19" {STROKE} stroke-width="6"/>'),
            ("w2", f'<path d="M34 32h19" {STROKE} stroke-width="6"/>'),
            ("w3", f'<path d="M34 45h19" {STROKE} stroke-width="6"/>'),
        ],
    },
    {
        "slug": "panels",
        "name": "Panels",
        "concept": "A tall lead tile beside three worker tiles. Reads as the app itself: a sidebar and a column of parallel runs.",
        "elements": [
            ("lead", '<rect x="12" y="11" width="20" height="42" rx="6" fill="{c}"/>'),
            ("w1", '<rect x="38" y="11" width="14" height="12" rx="4" fill="{c}"/>'),
            ("w2", '<rect x="38" y="26" width="14" height="12" rx="4" fill="{c}"/>'),
            ("w3", '<rect x="38" y="41" width="14" height="12" rx="4" fill="{c}"/>'),
        ],
    },
    {
        "slug": "huddle",
        "name": "Huddle",
        "concept": "A lead at the centre with three workers gathered around it. The softest, friendliest option; a small team in a huddle.",
        "elements": [
            ("lead", '<circle cx="32" cy="35" r="11" fill="{c}"/>'),
            ("w1", '<circle cx="32" cy="14" r="7.5" fill="{c}"/>'),
            ("w2", '<circle cx="50.2" cy="45.5" r="7.5" fill="{c}"/>'),
            ("w3", '<circle cx="13.8" cy="45.5" r="7.5" fill="{c}"/>'),
        ],
    },
]

CURRENT = {
    "slug": "current",
    "name": "Current mark (reference)",
    "concept": "The existing hub-and-spoke tree, shown for comparison.",
    "elements": [
        ("lead", f'<path d="M32 19L15 47M32 19V49M32 19L49 47" {STROKE} stroke-width="5.5"/>'),
        ("lead", '<circle cx="32" cy="19" r="9.5" fill="{c}"/>'),
        ("w1", '<circle cx="15" cy="47" r="6.5" fill="{c}"/>'),
        ("w2", '<circle cx="32" cy="49" r="6.5" fill="{c}"/>'),
        ("w3", '<circle cx="49" cy="47" r="6.5" fill="{c}"/>'),
    ],
}


def inner(variant, paint):
    """paint: dict role -> color string."""
    return "\n".join("  " + el.format(c=paint[role]) for role, el in variant["elements"])


def mono(color):
    return {"lead": color, "w1": color, "w2": color, "w3": color}


def svg_mark(variant):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
        f'  <title>Teamlet mark: {variant["name"]}</title>\n'
        f'{inner(variant, mono("currentColor"))}\n'
        "</svg>\n"
    )


def svg_icon(variant):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
        f'  <title>Teamlet icon: {variant["name"]}</title>\n'
        '  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#4d94ff"/><stop offset="1" stop-color="#1f5fe0"/></linearGradient></defs>\n'
        '  <rect width="64" height="64" rx="16" fill="url(#g)"/>\n'
        f'{inner(variant, mono("#fff"))}\n'
        "</svg>\n"
    )


def svg_inline(variant, paint, size, extra_class=""):
    return (
        f'<svg class="{extra_class}" width="{size}" height="{size}" viewBox="0 0 64 64" aria-hidden="true">'
        f'{inner(variant, paint)}</svg>'
    )


CSS = """
:root{--sans:"Inter",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:#dcdde3;font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;gap:12px}
.card{height:240px;border-radius:14px;padding:18px 22px;display:grid;grid-template-columns:200px repeat(6,1fr);gap:18px;align-items:center;background:var(--bg);color:var(--text);border:1px solid var(--border)}
[data-theme=light]{--bg:#f6f6f8;--surface:#fff;--border:#e6e7ec;--text:#15161b;--text-2:#4c5160;--text-3:#8a8fa0;--accent:#1f6fe5;--accent-deep:#1848b8;--claude:#c8623b;--codex:#0c9c78;--run:#6d5be6;--run2:#b97409}
[data-theme=dark]{--bg:#0b0c10;--surface:#14161c;--border:#22252e;--text:#ececf1;--text-2:#a3a8b6;--text-3:#6c7282;--accent:#3d8bff;--accent-deep:#1f5fe0;--claude:#e08360;--codex:#22c7a0;--run:#a08cff;--run2:#f2b14c}
.meta h2{margin:0 0 6px;font-size:17px;font-weight:680;letter-spacing:-0.02em}
.meta p{margin:0;font-size:12px;line-height:1.45;color:var(--text-2)}
.meta .tag{display:inline-block;margin-top:10px;font:11px var(--mono);color:var(--text-3)}
.cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:200px;border-radius:12px;background:var(--surface);border:1px solid var(--border)}
.cell .lbl{font-size:11px;color:var(--text-3);letter-spacing:0.02em}
.tile{display:inline-grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-deep));box-shadow:0 4px 14px color-mix(in srgb,var(--accent) 35%,transparent)}
.tile.s28{width:28px;height:28px;border-radius:8px}
.tile.s44{width:44px;height:44px;border-radius:12px}
.tile.s64{width:64px;height:64px;border-radius:16px}
.brand{display:flex;align-items:center;gap:10px}
.brand-name{font-weight:650;font-size:15px;letter-spacing:-0.01em}
.lockup{display:flex;align-items:center;gap:9px;color:var(--text)}
.lockup .word{font-weight:680;font-size:22px;letter-spacing:-0.025em}
.lockup svg{color:var(--accent)}
.mark{color:var(--accent)}
.row{display:flex;gap:14px;align-items:center}
.sheet-title{font-size:13px;color:#4c5160;padding:4px 2px 0}
.overview{height:250px;border-radius:14px;padding:18px 22px;display:grid;grid-template-columns:repeat(6,1fr);gap:14px;background:var(--bg);color:var(--text);border:1px solid var(--border)}
.overview .cell{height:214px;gap:12px}
.overview .name{font-size:13px;font-weight:650;letter-spacing:-0.01em;color:var(--text)}
"""


def overview(theme):
    cells = ""
    for v in VARIANTS:
        white = mono("#fff")
        cells += (f'<div class="cell"><span class="tile s64">{svg_inline(v, white, 40)}</span>'
                  f'<div class="lockup">{svg_inline(v, mono("var(--accent)"), 22)}<span class="word" style="font-size:19px">Teamlet</span></div>'
                  f'<div class="brand"><span class="tile s28">{svg_inline(v, white, 18)}</span><span class="brand-name">Teamlet</span></div>'
                  f'<span class="name">{v["name"]}</span></div>')
    return f'<section class="overview" data-theme="{theme}">{cells}</section>'


def card(variant, theme):
    accent = "var(--accent)"
    tinted = {"lead": accent, "w1": "var(--claude)", "w2": "var(--codex)", "w3": "var(--run)"}
    white = mono("#fff")
    slug = variant["slug"]
    icon_src = f"../teamlet-{slug}-icon.svg" if slug != "current" else "../../../web/public/favicon.svg"
    return f"""
<section class="card" data-theme="{theme}">
  <div class="meta"><h2>{variant['name']}</h2><p>{variant['concept']}</p><span class="tag">{theme} theme</span></div>
  <div class="cell"><span class="tile s64">{svg_inline(variant, white, 40)}</span><span class="lbl">App icon</span></div>
  <div class="cell"><div class="brand"><span class="tile s28">{svg_inline(variant, white, 18)}</span><span class="brand-name">Teamlet</span></div><span class="lbl">Sidebar (actual size)</span></div>
  <div class="cell"><span class="tile s44">{svg_inline(variant, white, 28)}</span><span class="lbl">Sign-in / hero</span></div>
  <div class="cell">{svg_inline(variant, mono(accent), 64, "mark")}<span class="lbl">Bare mark</span></div>
  <div class="cell"><div class="row"><img src="{icon_src}" width="16" height="16"><img src="{icon_src}" width="24" height="24"><img src="{icon_src}" width="32" height="32"></div><span class="lbl">Favicon 16 / 24 / 32</span></div>
  <div class="cell"><div class="lockup">{svg_inline(variant, mono(accent), 26)}<span class="word">Teamlet</span></div>{svg_inline(variant, tinted, 36)}<span class="lbl">Lockup · provider-tinted</span></div>
</section>"""


def page(body, title):
    return f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title><style>{CSS}</style></head><body>{body}</body></html>"


def main():
    for v in VARIANTS:
        (HERE / f"teamlet-{v['slug']}-mark.svg").write_text(svg_mark(v))
        (HERE / f"teamlet-{v['slug']}-icon.svg").write_text(svg_icon(v))
        (HERE / "cards" / f"{v['slug']}.html").write_text(page(card(v, "light") + card(v, "dark"), v["name"]))
    (HERE / "cards" / "current.html").write_text(page(card(CURRENT, "light") + card(CURRENT, "dark"), "Current"))
    (HERE / "cards" / "overview.html").write_text(page(overview("light") + overview("dark"), "Teamlet logo variants"))
    everything = '<div class="sheet-title">Teamlet logo variants. Each row shows the mark in the places the app really uses it.</div>'
    for v in VARIANTS + [CURRENT]:
        everything += card(v, "light") + card(v, "dark")
    (HERE / "cards" / "index.html").write_text(page(everything, "Teamlet logo variants"))
    print("wrote", len(VARIANTS), "variants")


if __name__ == "__main__":
    main()
