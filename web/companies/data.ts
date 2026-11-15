import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  Channel,
  Company,
  Facts,
  Inbox,
  Member,
  SlackBotStatus,
  SlackDecision,
  SlackGoal,
  ThreadSummary,
  User,
} from "../app/types.ts";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: ({ signal }) =>
    request<{ user: User; companies: Company[]; admin: boolean }>("/me", {
      signal,
    }),
});

/** The person and their companies; the signed-in routes render only once they are known. */
export function useMe() {
  return useQuery(meQuery).data!;
}

/** The channels and the threads of a company come in one response, which both collections read. */
const loading = new Map<string, Promise<{ channels: Channel[] }>>();

function companyState(companyId: string) {
  let pending = loading.get(companyId);
  if (!pending) {
    pending = request<{ channels: Channel[] }>(
      `/companies/${companyId}`
    ).finally(() => loading.delete(companyId));
    loading.set(companyId, pending);
  }
  return pending;
}

/** Loads the channels and threads of a company again, as agents start threads and channels while they work. */
export function refreshCompany(companyId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: ["companies", companyId, "channels"],
  });
}

/**
 * Merges a channel into another: its threads, files, artifacts, and routines move there, and the empty channel goes.
 * Channels are never deleted.
 */
export async function mergeChannel(
  companyId: string,
  channelId: string,
  into: string
): Promise<void> {
  await request(`/companies/${companyId}/channels/${channelId}/merge`, {
    method: "POST",
    body: { into },
  });
  await refreshCompany(companyId);
}

/** The channels of a company, in the server's order. Renaming one shows at once. */
export const channelsOf = keyed((companyId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `channels:${companyId}`,
      queryKey: ["companies", companyId, "channels", "list"],
      queryClient,
      queryFn: async () =>
        (await companyState(companyId)).channels.map(
          ({ threads, ...channel }, order) => ({ ...channel, order })
        ),
      getKey: (channel) => channel.id,
      // The collection loads again after it, with the name as the server keeps it.
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/companies/${companyId}/channels/${mutation.key}`, {
            method: "PUT",
            body: { name: mutation.modified.name },
          });
        }
      },
    })
  )
);

/** The threads of every channel of a company. Settling or moving one shows at once. */
export const threadsOf = keyed((companyId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `threads:${companyId}`,
      queryKey: ["companies", companyId, "channels", "threads"],
      queryClient,
      queryFn: async () =>
        (await companyState(companyId)).channels.flatMap(
          (channel) => channel.threads
        ),
      getKey: (thread) => thread.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(
            mutation.changes.channelId
              ? `/companies/${companyId}/threads/${mutation.key}/channel`
              : `/companies/${companyId}/threads/${mutation.key}/settled`,
            {
              method: "POST",
              body: mutation.changes.channelId
                ? { channelId: mutation.modified.channelId }
                : { settled: mutation.modified.settledAt !== null },
            }
          );
        }
      },
    })
  )
);

/** The person's notifications in a company, newest first; the sidebar shows how many are unread. */
export function inboxQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "notifications"],
    queryFn: ({ signal }) =>
      request<Inbox>(`/companies/${companyId}/notifications`, { signal }),
  });
}

/** Loads the inbox again: a run that ends or a thread that opens changes it. */
export function refreshInbox(companyId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: inboxQuery(companyId).queryKey,
  });
}

/** The company's thread that never ends; the first request makes it. */
export function orchestratorQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "orchestrator"],
    queryFn: ({ signal }) =>
      request<ThreadSummary>(`/companies/${companyId}/orchestrator`, {
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function membersQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "members"],
    queryFn: ({ signal }) =>
      request<Member[]>(`/companies/${companyId}/members`, { signal }),
  });
}

/** The address of a member's profile picture, or null for none or while the members load. */
export function usePicture(
  companyId: string,
  userId: string | null
): string | null {
  return (
    useQuery({
      ...membersQuery(companyId),
      select: (members) =>
        members.find((member) => member.userId === userId)?.picture ?? null,
    }).data ?? null
  );
}

/** The Slack bot of a company, for its admins. */
/** The Slack channels with their goals for ambient listening, for admins. */
export function slackGoalsQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "slack", "goals"],
    queryFn: ({ signal }) =>
      request<SlackGoal[]>(`/companies/${companyId}/slack/goals`, { signal }),
  });
}

/** What ambient listening decided lately, without the text of messages, for admins. */
export function slackDecisionsQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "slack", "decisions"],
    queryFn: ({ signal }) =>
      request<SlackDecision[]>(`/companies/${companyId}/slack/decisions`, {
        signal,
      }),
  });
}

export function slackBotQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "slack-bot"],
    queryFn: ({ signal }) =>
      request<SlackBotStatus>(`/companies/${companyId}/slack-bot`, {
        signal,
      }),
  });
}

export function factsQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "facts"],
    queryFn: ({ signal }) =>
      request<Facts>(`/companies/${companyId}/facts`, { signal }),
  });
}

/** Settles a thread, or brings it back. */
export function setSettled(
  companyId: string,
  threadId: string,
  settled: boolean
) {
  return threadsOf(companyId).update(threadId, (draft) => {
    draft.settledAt = settled ? Date.now() : null;
  });
}

const OPENED = "shadow-opened";
const OPEN_CHANNELS = "shadow-open-channels";

/** The ids of the channels whose threads this browser shows in the sidebar; the others start folded. */
export function openChannels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OPEN_CHANNELS) ?? "[]");
  } catch {
    return [];
  }
}

/** Remembers the open channels, so the sidebar shows their threads next time. */
export function rememberOpenChannels(channelIds: string[]): void {
  localStorage.setItem(OPEN_CHANNELS, JSON.stringify(channelIds));
}

/** Remembers the channel or thread page, so the company opens on it next time. */
export function rememberOpened(path: string): void {
  localStorage.setItem(OPENED, path);
}

/** The company and the channel or thread id of the page `rememberOpened` saw last. */
export function lastOpened():
  | { companyId: string; channelId?: string; threadId?: string }
  | undefined {
  const [, companyId, kind, id] =
    localStorage
      .getItem(OPENED)
      ?.match(/^\/c\/([^/]+)\/(channel|thread)\/([^/]+)$/) ?? [];
  if (!companyId) {
    return undefined;
  }
  return kind === "channel"
    ? { companyId, channelId: id }
    : { companyId, threadId: id };
}
