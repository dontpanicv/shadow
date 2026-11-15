import { afterEach, expect, test } from "bun:test";
import { afterCalendarDays, localDay, localTime } from "./time.ts";

// bun test runs in UTC without TZ, so the other tests get back the zone itself.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = zone;
});

test("a time is the company's clock with its offset, across daylight-saving changes", () => {
  process.env.TZ = "Europe/Prague";
  for (const [utc, local] of [
    ["2026-11-07T08:00:00Z", "2026-11-07T09:00+01:00"],
    ["2026-07-01T22:30:15Z", "2026-07-02T00:30+02:00"],
    ["2026-03-29T00:59:59Z", "2026-03-29T01:59+01:00"],
    ["2026-03-29T01:00:00Z", "2026-03-29T03:00+02:00"],
  ]) {
    expect(localTime(Date.parse(utc!))).toBe(local!);
    expect(Date.parse(local!)).toBe(
      Date.parse(utc!.replace(/:\d\dZ$/, ":00Z"))
    );
  }
  expect(localDay(Date.parse("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
  expect(
    localTime(Date.parse("2026-07-01T22:30:00Z"), "America/New_York")
  ).toBe("2026-07-01T18:30-04:00");
});

test("calendar days keep the time of the clock across a daylight-saving change", () => {
  process.env.TZ = "Europe/Prague";
  const before = Date.parse("2026-03-28T09:00:00+01:00");
  expect(localTime(afterCalendarDays(before, 2))).toBe(
    "2026-03-30T09:00+02:00"
  );
});
