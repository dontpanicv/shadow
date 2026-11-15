import { expect, test } from "bun:test";
import { cells, logo, shaded, svg } from "../scripts/icon.ts";

test("about half of the shadow's noise cells take the accent", () => {
  let lit = 0;
  for (let y = 0; y < 60; y += 1) {
    for (let x = 0; x < 60; x += 1) {
      lit += shaded(x, y) ? 1 : 0;
    }
  }
  expect(lit / 3600).toBeGreaterThan(0.45);
  expect(lit / 3600).toBeLessThan(0.65);
});

test("design/icon.svg and public/icon.svg are current", async () => {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    expect(await Bun.file(path).text(), `${path} is stale`).toBe(svg());
  }
});

test("the touch icon's noise cells are 3 px, so a home screen cannot blur them", () => {
  const pixels = cells(180, 3, 0.14, [0, 0, 0, 0xff]);
  const pixel = (x: number, y: number) => pixels[(y * 180 + x) * 4];
  // The badge's right edge, in its shadow: every px of a cell is the same.
  for (let x = 3 * 42; x < 3 * 46; x += 1) {
    expect(pixel(x, 3 * 17)).toBe(pixel(x - (x % 3), 3 * 17));
  }
});

test("the logo's cells are whole points", () => {
  const { ink, accent } = logo(24);
  expect(accent.startsWith("M10 0H14V1H10Z")).toBe(true);
  expect(ink + accent).not.toContain(".");
});
