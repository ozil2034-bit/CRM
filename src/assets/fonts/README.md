# Typefaces

Self-hosted since Phase 9. **The application must not request a font from any
third-party host**, because it has to work with no connection at all — and a
boutique that loses its Arabic typeface mid-morning falls back to whatever the
device happens to have, which for Arabic often renders the shop's own name
badly.

## What is here

| Family | Role | Subset | Weights |
| --- | --- | --- | --- |
| Inter | Latin body | latin | 400, 500, 600 |
| Cormorant Garamond | Latin display (headings) | latin | 400, 500, 600 |
| IBM Plex Sans Arabic | Arabic body | arabic | 400, 500, 600 |
| Noto Kufi Arabic | Arabic display (headings) | arabic | 400, 500, 600 |

Twelve WOFF2 files, about 428 KB in total.

Three weights because the design tokens use three. One subset per family
because a Latin display face has no use for Arabic glyphs and vice versa. No
italics, because nothing in the design system asks for one. Shipping the full
100–900 range of all four families would be several times the bytes for weights
nothing references.

## Licence

All four are under the **SIL Open Font License 1.1**. The full text for each is
in `./licenses/`; the OFL requires the licence to travel with the files, so
these are part of the deliverable rather than a courtesy.

Attribution is also shown in the application, under Settings → About.

## Provenance, and how to refresh

Extracted from the `@fontsource` v5 packages, which repackage the upstream
Google Fonts releases with per-weight, per-subset WOFF2 files.

To update a family:

```bash
npm install --no-save @fontsource/inter@5

# Copy only the weights and subset this project uses.
for w in 400 500 600; do
  cp "node_modules/@fontsource/inter/files/inter-latin-$w-normal.woff2" \
     "src/assets/fonts/inter-$w.woff2"
done

cp node_modules/@fontsource/inter/LICENSE src/assets/fonts/licenses/inter-OFL.txt
```

`--no-save` on purpose: the packages are a *source* for the files, not a runtime
dependency. Nothing imports `@fontsource` — `fonts.css` declares the faces
itself, so the built application has no dependency on the package having been
installed.

The subset name differs per family. Latin faces use `-latin-`; the Arabic faces
use `-arabic-`. Check `ls node_modules/@fontsource/<family>/files/` before
copying.
