import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "../platform/database.ts";
import { newestWithin, SlackHistory } from "./slack-history.ts";

test("a brief reads the newest messages that fit, oldest first, and at least the newest one", () => {
  const message = (text: string) => ({ text });
  expect(
    newestWithin([message("aaaa"), message("bb"), message("cc")], 4)
  ).toEqual([message("bb"), message("cc")]);
  expect(newestWithin([message("aaaa"), message("bbbbbb")], 4)).toEqual([
    message("bbbbbb"),
  ]);
  expect(newestWithin([message("a"), message("b")], 10)).toHaveLength(2);
  expect(newestWithin([], 10)).toEqual([]);
});

test("a Linear issue key is named only as a whole key, in any case", () => {
  const database = authDatabase();
  migrate(database);
  const insert = database.query(
    "INSERT INTO slack_message (company_id, slack_channel_id, ts, author, text, files, day) VALUES ('co', ?, ?, 'Ann', ?, '[]', '2026-11-16')"
  );
  insert.run(
    "C1",
    "1",
    "Is <https://linear.app/acme/issue/PIP-1040/export|PIP-1040> done?"
  );
  insert.run("C2", "2", "pip-1040 ships today");
  insert.run("C3", "3", "PIP-10400 and XPIP-1040 are others");
  insert.run("C4", "4", "PIP-104 too");
  const history = new SlackHistory(
    database,
    {} as never,
    {} as never,
    {} as never
  );
  expect(history.mentioning("co", "PIP-1040")).toEqual(
    expect.arrayContaining(["C1", "C2"])
  );
  expect(history.mentioning("co", "PIP-1040")).toHaveLength(2);
  expect(history.mentioning("co", "PIP-104")).toEqual(["C4"]);
  expect(history.mentioning("co", "PIP-1040' OR 1")).toEqual([]);
});
