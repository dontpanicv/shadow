import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  FollowingChange,
  FollowingCheck,
  FollowingDetail,
  FollowingOverview,
  LedgerSection,
} from "../app/types.ts";

/** The person's ledger; a state change shows at once and rolls back if the server refuses it. */
export const followingOf = keyed((companyId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `following:${companyId}`,
      queryKey: ["companies", companyId, "following"],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ checks: FollowingCheck[] }>(
          `/companies/${companyId}/following`,
          { signal }
        ),
      select: (response) => response.checks,
      getKey: (check) => check.id,
      // No event stream publishes intake changes.
      refetchInterval: 30_000,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          const input = mutation.metadata as
            | FollowingChange
            | { section: LedgerSection };
          try {
            const detail = await request<FollowingDetail>(
              "section" in input
                ? `/companies/${companyId}/following/${mutation.key}/section`
                : `/companies/${companyId}/following/${mutation.key}`,
              { method: "POST", body: input }
            );
            queryClient.setQueryData(
              followingDetailQuery(companyId, mutation.key).queryKey,
              detail
            );
          } finally {
            await queryClient.invalidateQueries({
              queryKey: followingDetailQuery(companyId, mutation.key).queryKey,
            });
          }
        }
      },
    })
  )
);

export function followingDetailQuery(companyId: string, id: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "following-detail", id],
    queryFn: ({ signal }) =>
      request<FollowingDetail>(`/companies/${companyId}/following/${id}`, {
        signal,
      }),
  });
}

export function changeFollowing(
  companyId: string,
  check: FollowingCheck,
  action: FollowingChange["action"],
  quote: string
) {
  return followingOf(companyId).update(
    check.id,
    {
      metadata: {
        action,
        quote,
        revision: check.revision,
      } satisfies FollowingChange,
    },
    (draft) => {
      if (action === "handled") {
        draft.state = "resolved";
      } else if (action === "stop") {
        draft.state = "stopped";
      } else if (action === "reopen") {
        draft.state = "open";
      }
      draft.updatedAt = Date.now();
    }
  ).isPersisted.promise;
}

/** Moves a row of the ledger to another section; it shows there at once. */
export function moveFollowing(
  companyId: string,
  check: FollowingCheck,
  section: LedgerSection
) {
  return followingOf(companyId).update(
    check.id,
    { metadata: { section } },
    (draft) => {
      draft.section = section;
      draft.updatedAt = Date.now();
    }
  ).isPersisted.promise;
}

/** All that intake holds for the person; `query` searches what it keeps. */
export function overviewQuery(companyId: string, query: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "following-overview", query],
    queryFn: ({ signal }) =>
      request<FollowingOverview>(
        `/companies/${companyId}/following/overview?q=${encodeURIComponent(query)}`,
        { signal }
      ),
    // No event stream publishes intake changes.
    refetchInterval: 30_000,
  });
}

export async function changeUpdate(
  companyId: string,
  id: string,
  action: "now" | "cancel"
) {
  await request(`/companies/${companyId}/following/updates/${id}`, {
    method: "POST",
    body: { action },
  });
  await queryClient.invalidateQueries({
    queryKey: ["companies", companyId, "following-overview"],
  });
}

export async function sendFeedback(
  companyId: string,
  target: string,
  quote: string
) {
  await request(`/companies/${companyId}/following/feedback`, {
    method: "POST",
    body: { target, quote },
  });
  await queryClient.invalidateQueries({
    queryKey: ["companies", companyId, "following-overview"],
  });
}

/**
 * Deletes a waiting update and blocks its senders, or its group chat: Shadow deletes what it read from them, with its
 * files, and reads nothing more from them.
 */
export async function deleteUpdate(companyId: string, id: string) {
  await request(`/companies/${companyId}/following/updates/${id}`, {
    method: "DELETE",
  });
  await queryClient.invalidateQueries({
    queryKey: ["companies", companyId, "following-overview"],
  });
}

/** Lets Shadow read a blocked sender or thread again. */
export async function unblock(companyId: string, id: string) {
  await request(`/companies/${companyId}/following/blocks/${id}`, {
    method: "DELETE",
  });
  await queryClient.invalidateQueries({
    queryKey: ["companies", companyId, "following-overview"],
  });
}
