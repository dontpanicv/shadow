import { expect, test } from "bun:test";
import { checkLinearKey, linearReads } from "./linear.ts";

/** Linear's API as a key with or without the write scope sees it. */
function linear(writes: boolean): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body)) as { query: string };
    if (query.startsWith("mutation")) {
      return Response.json({
        errors: [
          {
            message: writes
              ? "Entity not found: Team"
              : "Invalid scope: `write` or `issues:create` required",
          },
        ],
      });
    }
    return Response.json({ data: { organization: { name: "Meiro" } } });
  }) as typeof fetch;
}

test("a company key of Linear only reads", async () => {
  expect(await checkLinearKey("lin_api_read", linear(false))).toBe("Meiro");
  await expect(checkLinearKey("lin_api_write", linear(true))).rejects.toThrow(
    "can change issues"
  );
  expect(
    [
      "linear_list_issues",
      "linear_get_issue",
      "linear_search_documentation",
      "linear_get_notifications",
      "linear_mark_notification",
      "linear_save_issue",
      "linear_save_comment",
      "linear_share_issue",
    ].filter(linearReads)
  ).toEqual([
    "linear_list_issues",
    "linear_get_issue",
    "linear_search_documentation",
  ]);
});
