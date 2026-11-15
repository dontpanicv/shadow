/**
 * Generates Golem's logo, "Half Badge": an employee badge whose right half is its shadow. `bun scripts/icon.ts` writes
 * the web app's icons, and `logo` gives `bun run tokens` the path that the web app draws. In the drawing (`icon.golem`
 * in `design/tokens.json`), `#` is white, `o` is the accent, and `+` is the shadow: the accent in noise. One cell of the
 * noise is 1 point at the size where the logo shows, as in the UI's dither, so the grain stays visible: a finer one
 * blurs into a gradient on a phone's home screen.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { zlibSync } from "fflate";
import tokens from "../design/tokens.json" with { type: "json" };

const ACCENT_COLOR = tokens.color.accent.dark;
const ACCENT = [...Buffer.from(ACCENT_COLOR.slice(1), "hex"), 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const BLACK = [0, 0, 0, 0xff];

const TILE_PADDING = 0.14;
const MARK_PADDING = 0.1;
const ART = tokens.icon.golem.split("|");
const COLUMNS = Math.max(...ART.map((row) => row.length));
/** The share of the shadow's noise cells in the accent. */
const SHADOW = 0.55;

/** Each raster: the path, its size in px, the px of one noise cell, the tile's padding, and the background. */
const RASTERS: readonly [string, number, number, number, number[]][] = [
  ["public/icon.png", 64, 2, TILE_PADDING, BLACK],
  ["public/apple-touch-icon.png", 180, 3, TILE_PADDING, BLACK],
];

if (import.meta.main) {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    await Bun.write(path, svg());
  }
  for (const side of [24, 48, 96]) {
    await Bun.write(`public/logo-${side}.svg`, svg(side, MARK_PADDING, null));
  }
  for (const [path, size, grain, padding, background] of RASTERS) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, png(size, cells(size, grain, padding, background)));
  }
}

/** The logo with `side` cells across: on a tile if `background` is given, and sharp at 1 unit a cell. */
export function svg(
  side = 32,
  padding = TILE_PADDING,
  background: string | null = "#000000"
): string {
  const { ink, accent } = logo(side, padding);
  const tile = background
    ? `<rect width="${side}" height="${side}" fill="${background}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><title>Golem</title>${tile}<path fill="#ffffff" d="${ink}"/><path fill="${ACCENT_COLOR}" d="${accent}"/></svg>\n`;
}

/** The paths of the white cells and the accent cells, for the same absolute commands as the pixel icons. */
export function logo(
  side: number,
  padding = MARK_PADDING
): { ink: string; accent: string } {
  return {
    ink: runs(side, padding, WHITE),
    accent: runs(side, padding, ACCENT),
  };
}

/** True where a cell of the shadow takes the accent. */
export function shaded(x: number, y: number): boolean {
  return noise(x, y) < SHADOW;
}

/** One rectangle for each run of cells in `color`, row by row. */
function runs(side: number, padding: number, color: number[]): string {
  let path = "";
  for (let y = 0; y < side; y += 1) {
    let start = -1;
    for (let x = 0; x <= side; x += 1) {
      const inside = x < side && colorAt(x, y, side, padding, BLACK) === color;
      if (inside && start < 0) {
        start = x;
      } else if (!inside && start >= 0) {
        path += `M${start} ${y}H${x}V${y + 1}H${start}Z`;
        start = -1;
      }
    }
  }
  return path;
}

/** The drawing's area: a whole number of noise cells for each of its pixels, so that its edges are sharp. */
function grid(
  size: number,
  padding: number
): { left: number; top: number; cell: number } {
  // The drawing is taller than wide, so its rows set the size.
  const cell = Math.round(((1 - 2 * padding) * size) / ART.length);
  return {
    left: Math.floor((size - cell * COLUMNS) / 2),
    top: Math.floor((size - cell * ART.length) / 2),
    cell,
  };
}

function colorAt(
  x: number,
  y: number,
  side: number,
  padding: number,
  background: number[]
): number[] {
  const { left, top, cell } = grid(side, padding);
  const pixel =
    ART[Math.floor((y - top) / cell)]?.[Math.floor((x - left) / cell)];
  if (pixel === "#") {
    return WHITE;
  }
  if (pixel === "o" || (pixel === "+" && shaded(x, y))) {
    return ACCENT;
  }
  return background;
}

/** The RGBA pixels of a raster; whole cells of `grain` px, centered, with any px left over as background. */
export function cells(
  size: number,
  grain: number,
  padding: number,
  background: number[]
): Uint8Array {
  const side = Math.floor(size / grain);
  const margin = Math.floor((size - side * grain) / 2);
  const cellAt = (px: number) => Math.floor((px - margin) / grain);
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      pixels.set(
        colorAt(cellAt(x), cellAt(y), side, padding, background),
        (y * size + x) * 4
      );
    }
  }
  return pixels;
}

function noise(x: number, y: number): number {
  return fraction(52.982_918_9 * fraction(0.067_110_56 * x + 0.005_837_15 * y));
}

function fraction(value: number): number {
  return value - Math.floor(value);
}

/** A PNG of RGBA pixels, each row with no filter. */
function png(size: number, pixels: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw.set(
      pixels.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(Bun.hash.crc32(body));
  return Buffer.concat([length, body, checksum]);
}
