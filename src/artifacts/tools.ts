import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import type { Artifact, ArtifactCompanies, Artifacts } from "./artifacts.ts";

const idParameter = Type.String({ description: "The artifact id" });

/** The tools that let agents make artifacts in their channel, change them, and read the data their visitors keep. */
export function artifactTools(
  artifacts: Artifacts,
  companies: ArtifactCompanies,
  companyId: string,
  realmOf: (conversationId: ConversationId) => Promise<string | null>
) {
  const threadOf = (conversationId: number) => {
    const thread = companies.threadOf(companyId, conversationId);
    if (!thread) {
      throw new Error("This tool works only in a thread.");
    }
    return thread;
  };
  /** The channel an artifact belongs to: the named one, or the thread's; null, the company, for an orchestrator. */
  const placeOf = (
    thread: { readonly channelId: string; readonly ownerId: string | null },
    realm: string | null,
    channel: string | undefined
  ) => {
    if (channel !== undefined) {
      const name = channel.replace(/^#/, "");
      const named = companies
        .channelsIn(companyId, realm)
        .find((candidate) => candidate.name === name);
      if (!named) {
        throw new Error(
          `There is no channel #${name}. list_channels shows the channels.`
        );
      }
      return named.id;
    }
    return thread.ownerId === null ? thread.channelId : null;
  };
  /** An artifact that the realm of the tool's thread sees. */
  const artifactOf = async (id: string, conversationId: ConversationId) => {
    const artifact = artifacts
      .inCompany(companyId, await realmOf(conversationId))
      .find((candidate) => candidate.id === id);
    if (!artifact) {
      throw new Error(
        `There is no artifact ${id}. artifacts_list shows the artifacts.`
      );
    }
    return artifact;
  };
  const visibility = Type.Optional(
    Type.Union([Type.Literal("members"), Type.Literal("public")], {
      description:
        "members: only members of this company, signed in. public: anyone with the link, such as a customer or a partner. Default members; choose public only when they want to share it outside the company.",
    })
  );

  return [
    defineTool({
      name: "artifacts_create",
      description: `Make an artifact and give its link to the people. It belongs to the channel of this thread, or to another channel you name, and stays there after the thread is settled; the orchestrator's belong to the company. Before you make one, look for an artifact to change with artifacts_list or recall. Never use an artifact to keep facts or a list; save files and say them in your answer. ${artifacts.runtime}`,
      parameters: Type.Object({
        title: Type.String({
          description: "A short title; link previews show it",
        }),
        html: Type.String({ description: "The whole HTML document" }),
        visibility,
        channel: Type.Optional(
          Type.String({
            description:
              "The name of the channel it belongs to, such as recipes, when it is not this thread's channel",
          })
        ),
      }),
      // The request key comes from the task, so a rerun after a crash finds the artifact it made before.
      replay: "safe",
      execute: async ({ channel, ...args }, api) => {
        const thread = threadOf(api.conversationId);
        const artifact = artifacts.create(
          thread,
          placeOf(thread, await realmOf(api.conversationId), channel),
          {
            ...args,
            requestKey: `${companyId}:${api.taskId}`,
          }
        );
        return text(
          `Made the artifact.\n${describe(artifact)}\nShow it in your answer with ![${artifact.title}](artifact:${artifact.id}).`
        );
      },
    }),

    defineTool({
      name: "artifacts_update",
      description:
        "Replace the HTML, title, or visibility of an artifact. Its data stays, so read it with artifacts_data before you change how the page stores it.",
      parameters: Type.Object({
        id: idParameter,
        title: Type.Optional(Type.String()),
        html: Type.Optional(
          Type.String({ description: "The whole new HTML document" })
        ),
        visibility,
      }),
      replay: "safe",
      execute: async ({ id, ...changes }, api) =>
        text(
          `Changed the artifact.\n${describe(artifacts.update(companyId, (await artifactOf(id, api.conversationId)).id, changes))}`
        ),
    }),

    defineTool({
      name: "artifacts_edit",
      description:
        "Change part of an artifact's HTML: replace the one place where `find` occurs with `replace`. Cheaper than artifacts_update for small changes. artifacts_read shows the HTML.",
      parameters: Type.Object({
        id: idParameter,
        find: Type.String({ description: "Text that occurs exactly once" }),
        replace: Type.String(),
      }),
      execute: async ({ id, find, replace }, api) => {
        const html = artifacts.html(
          (await artifactOf(id, api.conversationId)).id
        );
        const count = html.split(find).length - 1;
        if (count !== 1) {
          throw new Error(
            `The text occurs ${count} times; give text that occurs exactly once.`
          );
        }
        artifacts.update(companyId, id, {
          html: html.replace(find, () => replace),
        });
        return text("Changed the artifact.");
      },
    }),

    defineTool({
      name: "artifacts_read",
      description: "The HTML of an artifact.",
      parameters: Type.Object({ id: idParameter }),
      replay: "safe",
      // All of the largest page, at up to 3 bytes for each UTF-16 unit.
      outputLimits: { maxBytes: 3 * artifacts.maxHtml },
      execute: async ({ id }, api) =>
        text(artifacts.html((await artifactOf(id, api.conversationId)).id)),
    }),

    defineTool({
      name: "artifacts_list",
      description:
        "List the artifacts of this company, newest first, with their links, channels, and the threads that made them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const realm = await realmOf(api.conversationId);
        const channels = companies.channelsIn(companyId, realm);
        const threads = companies.threadsIn(companyId, realm);
        const list = artifacts.inCompany(companyId, realm).map((artifact) => {
          const channel = channels.find(
            (candidate) => candidate.id === artifact.channelId
          );
          const thread = threads.find(
            (candidate) => candidate.id === artifact.threadId
          );
          const place = channel ? `Channel: #${channel.name}` : "The company's";
          return `${describe(artifact)}\n${place}\nMade in: [${thread?.title}](thread:${artifact.threadId})`;
        });
        return text(list.join("\n\n") || "This company has no artifacts.");
      },
    }),

    defineTool({
      name: "artifacts_data",
      description:
        "Read the data an artifact keeps: the shared records (visitor null) and each visitor's records, with their names.",
      parameters: Type.Object({
        id: idParameter,
        prefix: Type.Optional(
          Type.String({ description: "Only keys that start with it" })
        ),
      }),
      replay: "safe",
      execute: async ({ id, prefix }, api) => {
        const records = artifacts.records(
          (await artifactOf(id, api.conversationId)).id,
          prefix
        );
        return text(
          records.length
            ? records.map((record) => JSON.stringify(record)).join("\n")
            : "The artifact keeps no data yet."
        );
      },
    }),

    defineTool({
      name: "artifacts_set_data",
      description:
        "Write or delete a shared record of an artifact, such as its settings, the levels of a game, or a flag that closes a poll. An artifact keeps at most 10 MB of records, up to 64 KB in each value; a record you delete stops counting.",
      parameters: Type.Object({
        id: idParameter,
        key: Type.String(),
        value: Type.Unknown({
          description: "Any JSON value; null deletes the record",
        }),
      }),
      replay: "safe",
      execute: async ({ id, key, value }, api) => {
        const artifact = await artifactOf(id, api.conversationId);
        if (value === null || value === undefined) {
          artifacts.moveSharedAside(artifact.id, key);
          return text("Deleted the record.");
        }
        artifacts.write(artifact.id, "shared", key, value);
        return text("Saved the record.");
      },
    }),
  ];
}

function describe(artifact: Artifact): string {
  return `${artifact.title} (id ${artifact.id}, ${artifact.visibility === "public" ? "anyone with the link" : "members only"}, ${artifact.visitors} visitors)\nLink: ${artifact.url}`;
}

function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}
