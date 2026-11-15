/**
 * The one form of a time that Shadow writes for agents and in files: ISO 8601 in the company's time zone, to the
 * minute, with its offset, such as 2026-11-07T09:00+01:00. The company's time zone is the server's, as for routines,
 * reminders, and the Slack copy. Agents give times back to tools in the same form.
 */

/** The company's time zone, such as Europe/Prague: the server's. */
export function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A time as the company reads it, such as 2026-11-07T09:00+01:00; `zone` for a reminder in another time zone. */
export function localTime(time: number, zone = timeZone()): string {
  const local = wallClock(time, zone);
  const shown = Date.UTC(
    Number(local.year),
    Number(local.month) - 1,
    Number(local.day),
    Number(local.hour),
    Number(local.minute),
    Number(local.second)
  );
  const offset = Math.round((shown - Math.floor(time / 1000) * 1000) / 60_000);
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}${offset < 0 ? "-" : "+"}${hours}:${minutes}`;
}

/** The company's calendar day of a time, as YYYY-MM-DD. */
export function localDay(time: number): string {
  const local = wallClock(time, timeZone());
  return `${local.year}-${local.month}-${local.day}`;
}

/** The company's clock time of a time, as HH:MM, under a heading that gives its day. */
export function localClock(time: number): string {
  const local = wallClock(time, timeZone());
  return `${local.hour}:${local.minute}`;
}

/** The hour of the company's clock, 0 to 23. */
export function localHour(time: number): number {
  return Number(wallClock(time, timeZone()).hour);
}

/** `days` calendar days after `at`, at the same time of the company's clock, also across daylight-saving changes. */
export function afterCalendarDays(at: number, days: number): number {
  const zone = timeZone();
  const local = wallClock(at, zone);
  const wall = Date.UTC(
    Number(local.year),
    Number(local.month) - 1,
    Number(local.day) + days,
    Number(local.hour),
    Number(local.minute),
    Number(local.second)
  );
  let result = wall;
  for (let i = 0; i < 3; i += 1) {
    const actual = wallClock(result, zone);
    const shown = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second)
    );
    result += wall - shown;
  }
  return result;
}

/** The date and time parts of a time on the clock of `zone`. */
function wallClock(time: number, zone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value])
  );
}
