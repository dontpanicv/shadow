import { expect, test } from "bun:test";
import { answerParts, plainText, slackMarkdown, stepWords } from "./format.ts";

test("Shadow's own links open in Shadow, and other links stay", () => {
  const place = { baseUrl: "https://shadow.example.com", companyId: "c1" };
  expect(
    slackMarkdown(
      "[plan](thread:t1), [deck](file:f1), [poll](artifact:amber-fox), [web](https://example.com)",
      place
    )
  ).toBe(
    "[plan](https://shadow.example.com/c/c1/thread/t1), [deck](https://shadow.example.com/api/v1/companies/c1/files/f1), [poll](https://shadow.example.com/a/amber-fox), [web](https://example.com)"
  );
});

test("a long answer is cut between paragraphs into parts that fit Slack, and an empty one still says something", () => {
  const paragraph = "word ".repeat(1000).trim();
  const parts = answerParts(
    Array.from({ length: 4 }, () => paragraph).join("\n\n")
  );
  expect(parts.length).toBe(2);
  expect(parts.every((part) => part.length <= 11_000)).toBe(true);
  expect(parts.join("\n\n")).toBe(
    Array.from({ length: 4 }, () => paragraph).join("\n\n")
  );
  expect(answerParts("  ")[0]).toContain("nothing to say");
});

test("steps read as words, and plain text has no marks", () => {
  expect(stepWords("google_mail_search")).toBe("Google mail search");
  expect(plainText("**Paid** on [Friday](https://x.example)")).toBe(
    "Paid on Friday"
  );
});
