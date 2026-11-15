import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { Message, Work } from "../app/types.ts";
import { TooltipProvider } from "../ui/components.tsx";
import { ApprovalRequest } from "./approval.tsx";
import Markdown from "./markdown.tsx";
import { continues, MessageView } from "./message.tsx";

/** The HTML of `node` on a page of the app's router. */
async function render(node: ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <TooltipProvider>{node}</TooltipProvider>,
    }),
    history: createMemoryHistory(),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

test("an answer's thread links open the thread, its files show, and nothing in it runs", async () => {
  const html = await render(
    <Markdown
      companyId="company"
      text={[
        "Started [Dinner <b>plan</b>](thread:abc-1), <i>*soon*</i>, and read ![the list](file:f-1).",
        '<img src="x" onerror="alert(1)"><script>alert(2)</script>',
        '[bad](javascript:alert(3)) <a href="https://example.com" onclick="alert(4)">site</a>',
        '<iframe src="https://example.com"></iframe>',
      ].join("\n\n")}
    />
  );
  expect(html).toContain('class="thread-link" href="/c/company/thread/abc-1"');
  expect(html).toContain("Dinner <b>plan</b>");
  expect(html).toContain('src="/api/v1/companies/company/files/f-1"');
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("<i><em>soon</em></i>");
  for (const unsafe of [
    "onerror",
    "onclick",
    "<script",
    "javascript:",
    "<iframe",
  ]) {
    expect(html).not.toContain(unsafe);
  }
});

test("a picture from another site shows as a link, and loads nothing", async () => {
  const html = await render(
    <Markdown
      companyId="company"
      text={[
        "![the dog](https://example.com/p.png)",
        '<img src="https://example.com/q.png">',
        '<picture><source srcset="https://example.com/r.png"></picture>',
      ].join("\n\n")}
    />
  );
  expect(html).toContain('href="https://example.com/p.png"');
  expect(html).toContain(">the dog</a>");
  expect(html).not.toContain('src="https');
  expect(html).not.toMatch(/srcset/i);
});

test("only a link to a path of this site opens in the app; one to another site opens a new tab", async () => {
  const html = await render(
    <Markdown
      companyId="company"
      text={[
        "[home](/c/company)",
        "[evil](//evil.example/a)",
        '<a href="/&#9;/evil.example/b">tab</a>',
        '<a href="/\\evil.example/c">slash</a>',
      ].join("\n\n")}
    />
  );
  expect(html).toContain('<a href="/c/company">home</a>');
  for (const link of html.match(/<a [^>]*evil\.example[^>]*>/g) ?? []) {
    expect(link).toContain('target="_blank"');
  }
  expect(html.match(/<a [^>]*evil\.example[^>]*>/g)).toHaveLength(3);
});

test("an artifact in an answer runs in its own sandboxed page", async () => {
  const html = await render(
    <Markdown companyId="company" text="![Votes](artifact:amber-fox)" />
  );
  expect(html).toContain('<iframe class="message-artifact"');
  expect(html).toContain('src="/a/amber-fox"');
});

const message = (work: Work): Message => ({
  id: "m",
  authorId: null,
  author: "Shadow",
  agent: true,
  text: "",
  time: 0,
  failed: false,
  streaming: work.endedAt === null,
  files: [],
  work,
});

const call = (text: string) => ({
  kind: "tool" as const,
  text,
  tool: "start_thread",
  input: null,
  output: null,
  running: false,
  failed: false,
});

test("the work before an answer is open while the agent works, then folds and says how long it took", async () => {
  const working = await render(
    <MessageView
      companyId="w"
      message={message({
        startedAt: Date.now() - 12_000,
        endedAt: null,
        stopped: false,
        steps: [{ ...call("Prague"), tool: "web_search", running: true }],
      })}
    />
  );
  expect(working).toContain('<details class="work working" open="">');
  expect(working).toContain("Working for <!-- -->12s");
  expect(working).toContain("Web search");

  const done = await render(
    <MessageView
      companyId="w"
      message={message({
        startedAt: 1000,
        endedAt: 9000,
        stopped: false,
        steps: [],
      })}
    />
  );
  expect(done).toContain('<details class="work">');
  expect(done).toContain("Worked for 8s");
});

test("calls of one tool in a row fold into one row, and a stopped turn says so", async () => {
  const html = await render(
    <MessageView
      companyId="w"
      message={message({
        startedAt: 1000,
        endedAt: 4000,
        stopped: true,
        steps: [call("[Dinner](thread:d-1)"), call("[Trip](thread:t-2)")],
      })}
    />
  );
  expect(html).toContain("Stopped after 3s");
  expect(html).toContain(
    '<span class="work-tool-name">Start thread</span><span class="work-tool-detail">2<!-- --> times</span>'
  );
  expect(html).toContain(
    'class="thread-link" href="/c/w/thread/d-1">Dinner</a>'
  );
});

test("a finished work shows one pixel for each tool call, and the face shows how the work went", async () => {
  const html = await render(
    <MessageView
      companyId="w"
      message={message({
        startedAt: 1000,
        endedAt: 4000,
        stopped: false,
        steps: [call("a"), { ...call("b"), failed: true }],
      })}
    />
  );
  expect(html).toContain(
    '<span aria-hidden="true" class="step-strip"><i class="done"></i><i class="failed"></i></span>'
  );
});

test("a card block shows its cards; one that is not valid shows as code", async () => {
  const html = await render(
    <Markdown
      companyId="w"
      text={[
        "```card",
        '[{"icon": "battery", "title": "Car", "value": "78 %", "detail": "412 km"}, {"value": "22 °C"}]',
        "```",
        "",
        "```card",
        '{"title": "No value"}',
        "```",
      ].join("\n")}
    />
  );
  expect(html).toContain('<span class="card-title">Car</span>');
  expect(html).toContain('<strong class="card-value">78 %</strong>');
  expect(html).toContain('<span class="card-detail">412 km</span>');
  expect(html).toContain('<strong class="card-value">22 °C</strong>');
  expect(html.match(/class="card-icon"/g)).toHaveLength(1);
  expect(html).toContain("<pre><code");
  expect(html).toContain("No value");
});

test("the working summary says the step Shadow is at, and an approval puts Allow first", async () => {
  const working = await render(
    <MessageView
      companyId="w"
      message={message({
        startedAt: Date.now() - 5000,
        endedAt: null,
        stopped: false,
        steps: [
          {
            ...call("sales"),
            tool: "google_calendar_events",
            running: true,
          },
        ],
      })}
    />
  );
  expect(working).toContain(
    '<span class="work-now">Google calendar events</span>'
  );

  const approval = await render(
    <ApprovalRequest
      approval={{
        id: "a",
        tool: "google_mail_send",
        text: "Send to anna@example.com: The offer",
        approverId: null,
        expiresAt: 0,
      }}
      threadId="t"
    />
  );
  expect(approval).toContain("<p>Send to anna@example.com: The offer</p>");
  expect(approval.indexOf("Allow")).toBeLessThan(approval.indexOf("Deny"));
  expect(approval).not.toContain("Allow for this turn");
});

test("a turn that another thread's answer started continues Shadow's message before it, and says where it came from", async () => {
  const relayed = message({
    startedAt: 1000,
    endedAt: 4000,
    stopped: false,
    steps: [
      { ...call("[SVJ Rokycanova 8](thread:s-1)"), tool: "from_thread" },
      call("x"),
    ],
  });
  const asked = message({
    startedAt: 0,
    endedAt: 1,
    stopped: false,
    steps: [],
  });
  const person = { ...asked, agent: false, author: "Vojta", work: null };
  expect(continues(relayed, asked)).toBe(true);
  expect(continues(relayed, person)).toBe(false);
  expect(continues(asked, asked)).toBe(false);

  const html = await render(
    <MessageView companyId="w" continued message={relayed} />
  );
  expect(html).toContain('class="message continued"');
  expect(html).not.toContain("message-meta");
  expect(html).toContain("From SVJ Rokycanova 8");
  expect(html).toContain(
    '<span aria-hidden="true" class="step-strip"><i class="done"></i></span>'
  );
});
