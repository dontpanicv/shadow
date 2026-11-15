/**
 * Generates Shadow's logo, "Long Shadow": a person who stands at the lower left and casts a long shadow up and to the
 * right, in the accent, that fades through noise away from their feet. `bun scripts/icon.ts` writes the web app's icons,
 * and `logo` gives `bun run tokens` the path that the web app draws. The drawing is a shape that each icon samples at
 * the center of each of its cells, so that every cell is a whole px or point and the grain stays sharp at each size.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { zlibSync } from "fflate";
import tokens from "../design/tokens.json" with { type: "json" };

const ACCENT_COLOR = tokens.color.accent.dark;
const ACCENT = [...Buffer.from(ACCENT_COLOR.slice(1), "hex"), 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const BLACK = [0, 0, 0, 0xff];

/** The feet, in 16 units across the logo's side. */
const FEET = [3, 14] as const;
/** How much larger the person is than the base sizes in `person`. */
const SCALE = 1.3;
/** The direction of the shadow, up from the ground to the right. */
const ANGLE = (45 * Math.PI) / 180;
/** The shadow's length, as a share of the person's height. */
const LENGTH = 1.3;
/** The share of the shadow's cells in the accent at its far end; at the feet, all of them. */
const FAR_SHARE = 0.2;

/** Each SVG logo: the path, and its cells across. Shown at 24, 48, and 96 px, a cell is 1, 2, and 3 px. */
const LOGOS: readonly [string, number][] = [
  ["public/logo-24.svg", 24],
  ["public/logo-48.svg", 24],
  ["public/logo-96.svg", 32],
];
/** Each raster: the path, its size in px, the px of one cell, and its cells across, centered on black. */
const RASTERS: readonly [string, number, number, number][] = [
  ["public/icon.png", 64, 2, 32],
  // A home screen rounds the corners, so the drawing leaves 18 px to each edge.
  ["public/apple-touch-icon.png", 180, 4, 36],
];

if (import.meta.main) {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    await Bun.write(path, svg());
  }
  for (const [path, side] of LOGOS) {
    await Bun.write(path, svg(side, null));
  }
  for (const [path, size, grain, side] of RASTERS) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, png(size, cells(size, grain, side, BLACK)));
  }
}

/** The logo with `side` cells across: on a tile if `background` is given, and sharp at 1 unit a cell. */
export function svg(side = 32, background: string | null = "#000000"): string {
  const { ink, accent } = logo(side);
  const tile = background
    ? `<rect width="${side}" height="${side}" fill="${background}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><title>Shadow</title>${tile}<path fill="#ffffff" d="${ink}"/><path fill="${ACCENT_COLOR}" d="${accent}"/></svg>\n`;
}

/** The paths of the white cells and the accent cells, for the same absolute commands as the pixel icons. */
export function logo(side: number): { ink: string; accent: string } {
  return { ink: runs(side, WHITE), accent: runs(side, ACCENT) };
}

/** One rectangle for each run of cells in `color`, row by row. */
function runs(side: number, color: number[]): string {
  let path = "";
  for (let y = 0; y < side; y += 1) {
    let start = -1;
    for (let x = 0; x <= side; x += 1) {
      const inside = x < side && colorAt(x, y, side, BLACK) === color;
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

/** The color of cell (x, y) of `side` cells across. */
function colorAt(
  x: number,
  y: number,
  side: number,
  background: number[]
): number[] {
  // The feet sit on a cell's corner, so that the person is the same on both sides.
  const snap = (units: number) => (Math.round((units * side) / 16) * 16) / side;
  const across = ((x + 0.5) * 16) / side - snap(FEET[0]);
  const up = snap(FEET[1]) - ((y + 0.5) * 16) / side;
  if (person(across, up)) {
    return WHITE;
  }
  // The shadow is the person turned onto the ground about their feet: `along` is the height that casts this point.
  const along = (across * Math.cos(ANGLE) + up * Math.sin(ANGLE)) / LENGTH;
  const aside = up * Math.cos(ANGLE) - across * Math.sin(ANGLE);
  // It lies only above the ground line and never behind the person.
  const behind = Math.abs(across) <= 1.7 * SCALE;
  if (up > 0 && along >= 0 && !behind && person(aside, along)) {
    const share = 1 - ((1 - FAR_SHARE) * along) / (9 * SCALE);
    return shaded(x, y, share) ? ACCENT : background;
  }
  return background;
}

/** True inside the person; `across` is from their middle and `up` from their feet, in 16 units. */
function person(across: number, up: number): boolean {
  const x = across / SCALE;
  const h = up / SCALE;
  const head = Math.hypot(x, h - 7.7) <= 1.5;
  // A body with round shoulders: a rectangle under a half-ellipse.
  const body =
    h >= 2.9 &&
    h <= 5.45 &&
    Math.abs(x) <= 1.7 &&
    (h <= 4.6 || (x / 1.7) ** 2 + (h - 4.6) ** 2 <= 1);
  const leg = h >= 0 && h < 2.9 && Math.abs(x) >= 0.45 && Math.abs(x) <= 1.5;
  return head || body || leg;
}

/** True where a cell of the shadow takes the accent, for `share` of the cells. */
export function shaded(x: number, y: number, share: number): boolean {
  return noise(x, y) < share;
}

/** The RGBA pixels of a raster; `side` whole cells of `grain` px, centered, with the px left over as background. */
export function cells(
  size: number,
  grain: number,
  side: number,
  background: number[]
): Uint8Array {
  const margin = Math.floor((size - side * grain) / 2);
  const cellAt = (px: number) => Math.floor((px - margin) / grain);
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [cellX, cellY] = [cellAt(x), cellAt(y)];
      const outside = cellX < 0 || cellY < 0 || cellX >= side || cellY >= side;
      pixels.set(
        outside ? background : colorAt(cellX, cellY, side, background),
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
