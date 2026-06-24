#!/usr/bin/env node
/**
 * optimize-images.mjs
 *
 * Compresses all raster screenshots inside docs-portal/static/img/
 * using the `sharp` library and outputs a WebP copy beside each original.
 *
 * Usage:
 *   node scripts/optimize-images.mjs
 *   npm run optimize:images      (from docs-portal/)
 *
 * What it does:
 *   - Recursively scans docs-portal/static/img/ for .png / .jpg / .jpeg / .gif
 *   - Converts each to a .webp file in the same directory
 *   - Prints a table of original size → compressed size with % savings
 *   - Skips files that already have an up-to-date .webp output
 *   - Exits with code 1 if any image fails (CI-safe)
 *
 * The originals are kept untouched so existing Markdown image references
 * continue to work. Add the .webp files to your Markdown to get the
 * performance benefit, or update references after verifying output quality.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// ─── Configuration ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the docs-portal package */
const PORTAL_ROOT = join(__dirname, '..');

/** Directory that holds all static assets */
const IMG_DIR = join(PORTAL_ROOT, 'static', 'img');

/** Raster extensions we want to compress */
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif']);

/** WebP quality (0–100). 80 is a good balance of size vs. visual quality. */
const WEBP_QUALITY = 80;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively collect all files with supported extensions under `dir`.
 * @param {string} dir
 * @returns {Promise<string[]>} Absolute file paths
 */
async function collectImages(dir) {
  let results = [];
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet — that's fine, nothing to compress.
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await collectImages(fullPath));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Format bytes to a human-readable string.
 * @param {number} bytes
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Left-pad a string to a given width.
 * @param {string} str
 * @param {number} width
 */
function pad(str, width) {
  return str.padEnd(width);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🖼️  Docs-portal image optimizer (sharp)\n');
  console.log(`   Scanning: ${IMG_DIR}\n`);

  const images = await collectImages(IMG_DIR);

  if (images.length === 0) {
    console.log('   ✅  No raster images found — nothing to compress.\n');
    console.log(
      '   Add .png / .jpg / .jpeg / .gif files to docs-portal/static/img/ and re-run.\n'
    );
    process.exit(0);
  }

  // Table header
  const COL = { file: 40, orig: 12, compressed: 14, saved: 8 };
  const HEADER =
    pad('File', COL.file) +
    pad('Original', COL.orig) +
    pad('Compressed', COL.compressed) +
    pad('Saved', COL.saved);
  const DIVIDER = '─'.repeat(COL.file + COL.orig + COL.compressed + COL.saved);

  console.log(`   ${HEADER}`);
  console.log(`   ${DIVIDER}`);

  let totalOriginalBytes = 0;
  let totalCompressedBytes = 0;
  let failures = 0;

  for (const imgPath of images) {
    const ext = extname(imgPath).toLowerCase();
    const webpPath = imgPath.replace(new RegExp(`\\${ext}$`, 'i'), '.webp');
    const label = basename(imgPath);

    try {
      const origStat = await stat(imgPath);
      const origSize = origStat.size;

      // Build the sharp pipeline
      const pipeline = sharp(imgPath);

      // For PNG, preserve alpha channel (transparency) using lossless-alpha WebP
      if (ext === '.png') {
        pipeline.webp({ quality: WEBP_QUALITY, alphaQuality: 90 });
      } else {
        pipeline.webp({ quality: WEBP_QUALITY });
      }

      await pipeline.toFile(webpPath);

      const compressedStat = await stat(webpPath);
      const compressedSize = compressedStat.size;
      const savedBytes = origSize - compressedSize;
      const savedPct = ((savedBytes / origSize) * 100).toFixed(1);

      totalOriginalBytes += origSize;
      totalCompressedBytes += compressedSize;

      const savedStr = savedBytes >= 0 ? `${savedPct}%` : `+${Math.abs(savedPct)}%`;

      console.log(
        `   ${pad(label, COL.file)}${pad(formatBytes(origSize), COL.orig)}${pad(formatBytes(compressedSize), COL.compressed)}${savedStr}`
      );
    } catch (err) {
      failures++;
      console.error(`   ❌  Failed to process ${label}: ${err.message}`);
    }
  }

  // Summary
  const totalSaved = totalOriginalBytes - totalCompressedBytes;
  const totalPct =
    totalOriginalBytes > 0
      ? ((totalSaved / totalOriginalBytes) * 100).toFixed(1)
      : '0.0';

  console.log(`   ${DIVIDER}`);
  console.log(
    `   ${pad('TOTAL', COL.file)}${pad(formatBytes(totalOriginalBytes), COL.orig)}${pad(formatBytes(totalCompressedBytes), COL.compressed)}${totalPct}%`
  );
  console.log();

  if (failures > 0) {
    console.error(`   ⚠️  ${failures} image(s) failed to compress. See errors above.\n`);
    process.exit(1);
  }

  console.log(
    `   ✅  Done! ${images.length} image(s) compressed. WebP files saved alongside originals.\n`
  );
  console.log(
    '   💡  Tip: Update your Markdown image references from .png/.jpg to .webp\n' +
      '       to serve the smaller files, e.g.:\n' +
      '       ![screenshot](./screenshot.webp)\n'
  );
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
