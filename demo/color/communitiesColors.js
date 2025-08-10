// Smarter, reusable community coloring utilities for the demo
// Contract:
// - buildCommunityPalette(communityIds: Iterable<any>, opts?): Map<id, ABGR>
// - hsvToABGR(h, s?, v?): ABGR
// Notes:
// - First, use a small color-blind friendly seed palette (Okabe–Ito 8).
// - Then extend with a low-discrepancy hue sequence and vary saturation/value
//   slightly to improve perceived separation for nearby indices.

const OKABE_ITO = [
  0x000000ff, // black
  0xE69F00ff, // orange
  0x56B4E9ff, // sky blue
  0x009E73ff, // bluish green
  0xF0E442ff, // yellow
  0x0072B2ff, // blue
  0xD55E00ff, // vermillion
  0xCC79A7ff, // reddish purple
].map(hexABGRFromRGB);

export function buildCommunityPalette(communityIds, opts = {}) {
  // Options: seedPalette, saturation, value
  const {
    seedPalette = OKABE_ITO,
    saturation = 0.78,
    value = 0.98,
  } = opts;

  const ids = Array.from(communityIds);
  const palette = new Map();

  // Assign seed palette first for best separation across first communities
  for (let i = 0; i < ids.length && i < seedPalette.length; i++) {
    palette.set(ids[i], seedPalette[i]);
  }

  // For the rest, use a golden-angle sequence in HSV with small S/V jitter
  const phi = 0.6180339887498949; // golden ratio conjugate
  for (let i = seedPalette.length; i < ids.length; i++) {
    const k = i - seedPalette.length;
    // Spread hues evenly with low discrepancy
    const h = frac(0.5 + k * phi);
    // Mild, deterministic jitter to reduce similarity when many communities
    const s = clamp01(saturation + 0.15 * (frac(k * 0.37) - 0.5));
    const v = clamp01(value - 0.12 * frac(k * 0.19));
    const color = hsvToABGR(h, s, v);
    palette.set(ids[i], color);
  }

  return palette;
}

export function hsvToABGR(h, s = 0.8, v = 1.0) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
  // ABGR 32-bit: A in lowest byte per w-gl convention used here
  return (R << 24) | (G << 16) | (B << 8) | 0xff;
}

export function uniqueColorsCount(paletteMap) {
  return new Set(paletteMap.values()).size;
}

function frac(x) { return x - Math.floor(x); }

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Convert 0xRRGGBBff to ABGR; if provided as 0xRRGGBB without alpha, add 0xff.
function hexABGRFromRGB(rgb) {
  // If value already includes alpha in lowest byte, leave it; else add 0xff.
  const hasAlpha = (rgb & 0xff) !== 0 && (rgb >>> 24) !== 0;
  const raw = hasAlpha ? rgb : ((rgb << 8) | 0xff);
  const R = (raw >>> 24) & 0xff;
  const G = (raw >>> 16) & 0xff;
  const B = (raw >>> 8) & 0xff;
  return (R << 24) | (G << 16) | (B << 8) | 0xff;
}
