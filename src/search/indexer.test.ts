import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../artifacts/artifacts.ts";
import type { ThreadRef, ThreadSummary } from "../companies/companies.ts";
import type { Message } from "../threads/threads.ts";
import type { Embedder, EmbedInput } from "./embedder.ts";
import { tools } from "./extract.ts";
import {
  type ArtifactReader,
  type CompanyDirectory,
  Indexer,
  type ThreadReader,
} from "./search.ts";

let dataDirectory: string;
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "shadow-indexer-"));
});
afterAll(() => rm(dataDirectory, { recursive: true, force: true }));

/** The directory the indexer reads: company ids, and the threads of each company and the channels they are in. */
function directory(
  ids: readonly string[] = [],
  threads: readonly (ThreadSummary & ThreadRef)[] = [],
  /** Channels that have no thread. */
  empty: readonly string[] = []
): CompanyDirectory {
  return {
    ids: () => [...ids],
    threadsIn: () => [...threads],
    allThreadsIn: () => [...threads],
    channelsIn: () => channels(),
    allChannelsIn: () => channels(),
  };
  function channels() {
    return [
      ...new Set([...threads.map((thread) => thread.channelId), ...empty]),
    ].map((id) => ({
      id,
      name: id,
      ownerId: null,
      summary: null,
      icon: null,
      slackId: null,
      slackPrivate: false,
      personal: false,
      threads: [],
    }));
  }
}

/** Artifacts with their HTML, instead of the database. */
function artifactsWith(
  pages: readonly { artifact: Artifact; html: string }[] = []
): ArtifactReader {
  return {
    inCompany: () => pages.map((page) => page.artifact),
    allInCompany: () => pages.map((page) => page.artifact),
    html: (id) => pages.find((page) => page.artifact.id === id)!.html,
  };
}

function message(
  id: string,
  text: string,
  state: Partial<Message> = {}
): Message {
  return {
    id,
    text,
    author: "Anna",
    authorId: null,
    agent: false,
    failed: false,
    files: [],
    streaming: false,
    time: 0,
    work: null,
    ...state,
  };
}

/** Thread messages come from lists by thread id instead of a session file. */
function threadsWith(
  messages: Readonly<Record<string, readonly Message[]>>
): ThreadReader {
  return {
    messages: async (thread) => ({
      messages: messages[thread.id] ?? [],
      running: false,
      approvals: [],
    }),
    version: async (thread) => String(messages[thread.id]?.length ?? 0),
  };
}

/** A vector with one component set: equal axes mean equal meaning. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(768);
  vector[index] = 1;
  return vector;
}

/**
 * Pictures and the word "beach" share one axis, other text another. Media can be made to fail, as when the model
 * stops while a file is read.
 */
function testEmbedder() {
  const state = { failMedia: false, failText: false, ready: true };
  const embedder: Embedder = {
    fingerprint: "test-axes",
    ready: () => state.ready,
    embed: async (inputs: readonly EmbedInput[]) => {
      const media = inputs.some((input) => typeof input !== "string");
      if ((media && state.failMedia) || (!media && state.failText)) {
        throw new Error("the model stopped");
      }
      return inputs.map((input) =>
        typeof input !== "string" || input.includes("beach") ? axis(0) : axis(1)
      );
    },
  };
  return { embedder, state };
}

/** Calls `check` until it returns true, or fails after `milliseconds`. */
async function until(
  check: () => boolean | Promise<boolean>,
  milliseconds = 5000
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("The condition did not become true in time");
    }
    await Bun.sleep(20);
  }
}

test("start creates each company's folders and indexes a new file soon after it is saved", async () => {
  const data = join(dataDirectory, "watch");
  const indexer = new Indexer(
    data,
    directory(["company"]),
    threadsWith({}),
    artifactsWith(),
    null
  );
  try {
    indexer.start();
    for (const folder of ["notes", "raw", "channels"]) {
      expect(
        statSync(join(data, "companies", "company", folder)).isDirectory()
      ).toBe(true);
    }
    await indexer.scan("company");
    expect(indexer.status("company")).toEqual({
      sources: 0,
      segments: 0,
      waiting: 0,
      model: false,
    });

    await Bun.write(
      join(data, "companies", "company", "notes", "shopping.md"),
      "# Shopping\n\nBuy oat milk and apples."
    );
    await until(
      async () =>
        (await indexer.search("company", "oat milk", 20, null)).results
          .length === 1
    );
    const found = await indexer.search("company", "oat milk", 20, null);
    expect(found.semantic).toBe(false);
    expect(found.results[0]).toMatchObject({
      kind: "note",
      title: "Shopping",
      uri: "notes/shopping.md",
    });
  } finally {
    await indexer.close();
  }
});

test("a scan indexes finished thread messages, artifacts, and channel files, and skips what it cannot use", async () => {
  const data = join(dataDirectory, "threads");
  const threads = directory(
    ["company"],
    [
      {
        id: "t1",
        companyId: "company",
        conversationId: 1,
        channelId: "c1",
        title: "Holiday",
        updatedAt: 5,
        settledAt: null,
        ownerId: null,
        realm: null,
      },
      {
        id: "t2",
        companyId: "company",
        conversationId: 2,
        channelId: "c1",
        title: "Empty",
        updatedAt: 6,
        settledAt: null,
        ownerId: null,
        realm: null,
      },
    ]
  );
  const channel = join(data, "companies", "company", "channels", "c1");
  await mkdir(join(channel, "files"), { recursive: true });
  await Bun.write(
    join(channel, "files", "tickets.txt"),
    "Ferry tickets for Saturday"
  );
  await Bun.write(join(channel, "files", "~$draft.docx"), "lock");
  await Bun.write(join(channel, "files", "broken report.docx"), "not a zip");
  const indexer = new Indexer(
    data,
    threads,
    threadsWith({
      t1: [
        message("m1", "We take the ferry to the island"),
        message("m2", "ferry answer in progress", { streaming: true }),
        message("m3", "ferry answer that failed", { failed: true }),
        message("m4", "Sent.", {
          agent: true,
          work: {
            startedAt: 0,
            endedAt: 1,
            stopped: false,
            steps: [
              {
                kind: "tool",
                text: "",
                tool: "execute",
                input:
                  '{"code": "google_mail_send({to: [\'office@quaybuilders.example\']})"}',
                output: null,
                running: false,
                failed: false,
              },
            ],
          },
        }),
      ],
    }),
    artifactsWith([
      {
        artifact: {
          id: "amber-fox",
          channelId: "c1",
          threadId: "t1",
          title: "Island trip",
          visibility: "members",
          url: "http://shadow.test/a/amber-fox",
          visitors: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        html: "<html><head><title>x</title><style>.ferry{}</style></head><body><h1>Island trip</h1><p>Ferry at 9:00</p></body></html>",
      },
    ]),
    null
  );
  try {
    await indexer.scan("company");
    const { results } = await indexer.search("company", "ferry", 20, null);
    expect(
      results
        .map((result) => [
          result.kind,
          result.uri,
          result.threadId,
          result.channelId,
        ])
        .sort()
    ).toEqual([
      ["artifact", "artifact:amber-fox", "t1", "c1"],
      ["file", "channels/c1/files/tickets.txt", null, "c1"],
      ["thread", "thread:t1", "t1", "c1"],
    ]);
    // The artifact's heading repeats its title, so the snippet leaves it out.
    expect(results.find((result) => result.kind === "artifact")?.snippet).toBe(
      "Ferry at 9:00"
    );
    expect(results.find((result) => result.kind === "thread")?.snippet).toBe(
      "Anna: We take the ferry to the island"
    );
    expect(
      (await indexer.search("company", "draft", 20, null)).results
    ).toEqual([]);
    // A tool call's arguments find the thread by whom it wrote to.
    expect(
      (await indexer.search("company", "quaybuilders", 20, null)).results.map(
        (result) => result.uri
      )
    ).toEqual(["thread:t1"]);
    // A file Shadow cannot read is still found by its name, with no snippet of its stored path.
    expect(
      (await indexer.search("company", "broken report", 20, null)).results.map(
        (result) => [result.uri, result.snippet]
      )
    ).toEqual([["channels/c1/files/broken report.docx", ""]]);
    expect(() => indexer.status("../other")).toThrow("Invalid company id");
  } finally {
    await indexer.close();
  }
});

test("search leaves out a deleted channel and a deleted artifact at once, before the next scan", async () => {
  const data = join(dataDirectory, "deleted");
  const live = { channels: ["c1"], artifacts: true };
  const thread = {
    id: "t1",
    companyId: "company",
    conversationId: 1,
    channelId: "c1",
    title: "Holiday",
    updatedAt: 5,
    settledAt: null,
    ownerId: null,
    realm: null,
  };
  const artifact = {
    id: "amber-fox",
    channelId: "c1",
    threadId: "t1",
    title: "Island trip",
    visibility: "members" as const,
    url: "http://shadow.test/a/amber-fox",
    visitors: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const liveChannels = () =>
    live.channels.map((id) => ({
      id,
      name: id,
      ownerId: null,
      summary: null,
      icon: null,
      slackId: null,
      slackPrivate: false,
      personal: false,
      threads: [],
    }));
  const indexer = new Indexer(
    data,
    {
      ids: () => ["company"],
      threadsIn: () => [thread],
      allThreadsIn: () => [thread],
      channelsIn: () => liveChannels(),
      allChannelsIn: () => liveChannels(),
    },
    threadsWith({ t1: [message("m1", "We take the ferry to the island")] }),
    {
      inCompany: () => (live.artifacts ? [artifact] : []),
      allInCompany: () => (live.artifacts ? [artifact] : []),
      html: () => "<p>Ferry at 9:00</p>",
    },
    null
  );
  const found = async () =>
    (await indexer.search("company", "ferry", 20, null)).results
      .map((result) => result.uri)
      .sort();
  try {
    await indexer.scan("company");
    expect(await found()).toEqual(["artifact:amber-fox", "thread:t1"]);
    live.artifacts = false;
    expect(await found()).toEqual(["thread:t1"]);
    live.artifacts = true;
    // A deleted channel takes its threads and artifacts with it.
    live.channels = [];
    expect(await found()).toEqual([]);
  } finally {
    await indexer.close();
  }
});

test("pictures read while the model is down are read again, and text waits for the background pass", async () => {
  const data = join(dataDirectory, "media");
  const fakeFfmpeg = join(dataDirectory, "ffmpeg");
  await Bun.write(
    fakeFfmpeg,
    "#!/bin/sh\nprintf '\\377\\330beach\\377\\331'\n"
  );
  await chmod(fakeFfmpeg, 0o755);
  const files = join(data, "companies", "company", "channels", "c1", "files");
  await mkdir(files, { recursive: true });
  await Bun.write(join(files, "IMG_0001.jpg"), "jpeg");
  await Bun.write(
    join(data, "companies", "company", "notes", "trip.md"),
    "The children want to visit the mountain lake again next summer"
  );
  const { embedder, state } = testEmbedder();
  const indexer = new Indexer(
    data,
    directory([], [], ["c1"]),
    threadsWith({}),
    artifactsWith(),
    embedder
  );
  const real = tools.ffmpeg;
  tools.ffmpeg = fakeFfmpeg;
  try {
    state.failMedia = true;
    await indexer.scan("company");
    expect(indexer.status("company")).toMatchObject({
      waiting: 0,
      model: true,
    });
    expect(
      (await indexer.search("company", "beach", 20, null)).results.map(
        (result) => result.modality
      )
    ).toEqual([]);

    state.failMedia = false;
    await indexer.scan("company");
    const beach = await indexer.search("company", "beach", 20, null);
    expect(beach.semantic).toBe(true);
    expect(
      beach.results.map((result) => [result.title, result.modality])
    ).toEqual([["IMG_0001", "image"]]);

    // Without a query vector, search still answers by keywords.
    state.failText = true;
    const lake = await indexer.search("company", "mountain lake", 20, null);
    expect(lake.semantic).toBe(false);
    expect(lake.results.map((result) => result.title)).toEqual(["trip"]);
  } finally {
    tools.ffmpeg = real;
    await indexer.close();
  }
});
