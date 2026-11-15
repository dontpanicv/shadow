import { expect, test } from "bun:test";
import { cells, logo, shaded, svg } from "../scripts/icon.ts";

test("about the given share of the shadow's noise cells take the accent", () => {
  for (const share of [0.2, 0.55, 1]) {
    let lit = 0;
    for (let y = 0; y < 60; y += 1) {
      for (let x = 0; x < 60; x += 1) {
        lit += shaded(x, y, share) ? 1 : 0;
      }
    }
    expect(Math.abs(lit / 3600 - share)).toBeLessThan(0.1);
  }
});

test("design/icon.svg and public/icon.svg are current", async () => {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    expect(await Bun.file(path).text(), `${path} is stale`).toBe(svg());
  }
});

test("the touch icon's cells are 4 px, so a home screen cannot blur them", () => {
  const pixels = cells(180, 4, 36, [0, 0, 0, 0xff]);
  const pixel = (x: number, y: number) => pixels[(y * 180 + x) * 4 + 1];
  // Cells start 18 px from the edge; every px of a cell is the same.
  for (let y = 18; y < 162; y += 1) {
    for (let x = 18; x < 162; x += 1) {
      expect(pixel(x, y)).toBe(pixel(x - ((x - 18) % 4), y - ((y - 18) % 4)));
    }
  }
});

test("the logo's cells are whole points", () => {
  for (const side of [16, 24, 32]) {
    const { ink, accent } = logo(side);
    expect(ink).not.toBe("");
    expect(accent).not.toBe("");
    expect(ink + accent).not.toContain(".");
  }
});
