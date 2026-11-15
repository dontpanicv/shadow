import { expect, test } from "bun:test";
import { newestWithin } from "./slack-history.ts";

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
