# docs-portal/scripts

Build-time utility scripts for the Mobile Money Docs Portal.

---

## `optimize-images.mjs`

Compresses all raster screenshots inside `docs-portal/static/img/` using
[**sharp**](https://sharp.pixelplumbing.com/) and saves a `.webp` version
alongside each original.

### Why WebP?

WebP is 25–34 % smaller than PNG/JPEG at equivalent perceived quality and is
supported by every modern browser (Chrome, Firefox, Safari 14+, Edge). Serving
WebP images directly reduces page weight and accelerates documentation load
times — the goal of issue [#1029](https://github.com/sublime247/mobile-money/issues/1029).

### How to run

```bash
# From the docs-portal directory
npm run optimize:images
```

Or invoke the script directly:

```bash
node scripts/optimize-images.mjs
```

The script is also wired into `npm run build`, so compression happens
automatically on every production build.

### What it does

1. Recursively scans `docs-portal/static/img/` for `.png`, `.jpg`, `.jpeg`, and `.gif` files.
2. Converts each image to `.webp` using `sharp` with **quality 80** (lossless-alpha for PNG transparency).
3. Saves the `.webp` file alongside the original — originals are **never modified**.
4. Prints a table showing per-file size savings:

```
   File                                    Original    Compressed    Saved
   ────────────────────────────────────────────────────────────────────────
   architecture-diagram.png                420.3 KB    298.7 KB      29.0%
   sequence-diagram.png                    185.6 KB    122.4 KB      34.1%
   ────────────────────────────────────────────────────────────────────────
   TOTAL                                   605.9 KB    421.1 KB      30.5%
```

5. Exits with code `1` if any file fails (safe for CI pipelines).

### Updating Markdown references

The originals are kept so no existing links break. Once you've verified the
WebP output quality, you can update your Markdown references to point to the
`.webp` files:

```md
<!-- Before -->
![Architecture diagram](./img/architecture-diagram.png)

<!-- After (smaller, faster) -->
![Architecture diagram](./img/architecture-diagram.webp)
```

### Configuration

Edit the constants at the top of `optimize-images.mjs`:

| Constant | Default | Description |
|---|---|---|
| `WEBP_QUALITY` | `80` | WebP quality (0–100) |
| `IMG_DIR` | `static/img` | Directory to scan |
| `SUPPORTED_EXTENSIONS` | `.png .jpg .jpeg .gif` | File types to compress |
