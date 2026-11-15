import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Sources } from "./sources.ts";

const SOURCE = Type.String({
  description: "The source's name, from the sources section",
});

/** The tools of the company's sources: every turn reads them, as every member does. */
export function sourceTools(sources: Sources) {
  const text = (value: string): ToolExecutionResult => ({
    output: [{ type: "text", text: value }],
  });
  return [
    defineTool({
      name: "sources_search",
      description:
        "Search the company's sources, such as its code and product docs, for lines that hold a text, as `<source>/<path>:<line>: <text>`. Search a short distinctive text, such as a name, an error, or a setting, then read the files around the lines with sources_read. The sources are a copy of the newest commit, pulled every 10 minutes.",
      parameters: Type.Object({
        text: Type.String({ description: "The text that a line holds" }),
        source: Type.Optional(
          Type.String({ description: "Only this source; all when not given" })
        ),
        path: Type.Optional(
          Type.String({
            description:
              "Only paths that match this glob, such as src/**/*.ts or **/*.mdx",
          })
        ),
        regex: Type.Optional(
          Type.Boolean({
            description: "text is an extended regular expression",
          })
        ),
        case_sensitive: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) =>
        text(
          await sources.search(args.text, {
            ...(args.source ? { source: args.source } : {}),
            ...(args.path ? { path: args.path } : {}),
            ...(args.regex ? { regex: true } : {}),
            ...(args.case_sensitive ? { caseSensitive: true } : {}),
          })
        ),
    }),
    defineTool({
      name: "sources_read",
      description:
        "Read a file of a source with its line numbers, or list a folder; path '.' lists the source. Cite what you use as <source>/<path>:<line>.",
      parameters: Type.Object({
        source: SOURCE,
        path: Type.String({ description: "The path in the source" }),
        from: Type.Optional(
          Type.Number({ description: "The first line; 1 when not given" })
        ),
        to: Type.Optional(Type.Number({ description: "The last line" })),
      }),
      execute: async (args) =>
        text(await sources.read(args.source, args.path, args.from, args.to)),
    }),
    defineTool({
      name: "sources_history",
      description:
        "The commits of a source, newest first, as `<hash> <date> <author>: <subject>`, such as who changed a file and when; or, with commit, that commit with its changes.",
      parameters: Type.Object({
        source: SOURCE,
        path: Type.Optional(
          Type.String({ description: "Only commits that change this path" })
        ),
        grep: Type.Optional(
          Type.String({ description: "Only commits whose message has this" })
        ),
        since: Type.Optional(
          Type.String({ description: "Only commits since, such as 2026-10-01" })
        ),
        commit: Type.Optional(
          Type.String({ description: "A commit hash, to show its changes" })
        ),
        limit: Type.Optional(
          Type.Number({ description: "How many commits; 30 when not given" })
        ),
      }),
      execute: async (args) => {
        const { source, ...options } = args;
        return text(await sources.history(source, options));
      },
    }),
  ];
}
