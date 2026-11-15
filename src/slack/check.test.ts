import { expect, test } from "bun:test";
import { checkMessage, SKIP_BELOW } from "./check.ts";

const goal = { wakeWhen: "invoices", engagement: "answer briefly" };
const messages = [
  { author: "Anna", text: "Lunch?" },
  { author: "Bob", text: "Was invoice 42 paid?" },
];

test("a message below the threshold is skipped, and the rest pass", async () => {
  const low = await checkMessage(
    async () => `{"probability": ${SKIP_BELOW / 2}}`,
    goal,
    null,
    messages
  );
  expect(low).toEqual({
    skip: true,
    probability: SKIP_BELOW / 2,
    reason: "decided",
  });
  const high = await checkMessage(
    async () => 'Sure: {"probability": 0.8}',
    goal,
    "Invoices of the company",
    messages
  );
  expect(high).toEqual({ skip: false, probability: 0.8, reason: "decided" });
});

test("the check fails open: an error, an answer without a number, or no conversation lets the message through", async () => {
  expect(
    await checkMessage(
      async () => {
        throw new Error("timeout");
      },
      goal,
      null,
      messages
    )
  ).toEqual({ skip: false, probability: null, reason: "error" });
  expect(
    await checkMessage(async () => "I think so", goal, null, messages)
  ).toEqual({ skip: false, probability: null, reason: "error" });
  expect(
    await checkMessage(async () => '{"probability": 0}', goal, null, [])
  ).toEqual({ skip: false, probability: null, reason: "incomplete-context" });
});

test("the check reads at most the last 10 messages, each cut short", async () => {
  let seen = "";
  await checkMessage(
    async (_system, text) => {
      seen = text;
      return '{"probability": 1}';
    },
    goal,
    null,
    Array.from({ length: 15 }, (_, index) => ({
      author: `P${index}`,
      text: "x".repeat(900),
    }))
  );
  expect(seen).not.toContain("P4:");
  expect(seen).toContain("P5:");
  expect(seen).not.toContain("x".repeat(501));
});
