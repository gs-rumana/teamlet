# Logo variants

Earlier exploration for the Teamlet mark, from when the app had a blue accent.
None of these shipped. The app now uses a T built from four tiles, with the lead
tile dark and the worker tiles gray: `web/public/favicon.svg` (app icon),
`web/public/logo.svg` (bare mark) and `TeamletMark` in `web/src/components/Logo.tsx`.

Each variant comes in two files:

- `teamlet-<name>-mark.svg`: the bare mark, painted with `currentColor`
- `teamlet-<name>-icon.svg`: 64px rounded gradient tile with a white mark (favicon / app icon)

`cards/` holds HTML previews of every variant in the places the app uses it
(sidebar at 18px, sign-in tile, favicon at 16/24/32, lockup) in both themes.
`cards/overview.png` shows all six side by side; `cards/index.png` is the full sheet.

## Variants

| Name   | Idea |
| ------ | ---- |
| Fork   | The lead splits one task into three parallel lanes |
| Loop   | Fork and join: split, run in parallel, merge back into one summary |
| Tee    | T monogram; crossbar is the lead, three lanes hang from it |
| Prompt | Terminal prompt followed by three parallel streams |
| Panels | Tall lead tile beside three worker tiles |
| Huddle | Lead at the centre with three workers gathered around it |

## Regenerate

```bash
python3 design/logo/generate.py   # rewrites the SVGs and the HTML previews
./design/logo/render.sh           # also renders PNGs with headless Chrome (macOS)
```

Geometry lives in `generate.py` as one description per variant, so tweaks
(stroke weight, spacing) only need to be made once.

## Adopting one

1. Copy `teamlet-<name>-icon.svg` over `web/public/favicon.svg`.
2. Copy `teamlet-<name>-mark.svg` over `web/public/logo.svg` (swap `currentColor` for `#15171C` if it is used outside the app).
3. Paste the same elements into `TeamletMark` in `web/src/components/Logo.tsx`, keeping `currentColor`.
4. Update the `<img>` at the top of the root `README.md` if the file name changes.
