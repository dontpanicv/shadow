import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type { Feedback } from "../app/types.ts";

/** What the agents of a company reported about Shadow, for an admin; a dismiss shows at once. */
export const feedbackOf = keyed((companyId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `feedback:${companyId}`,
      queryKey: ["companies", companyId, "feedback"],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ feedback: Feedback[] }>(`/companies/${companyId}/feedback`, {
          signal,
        }),
      select: (response) => response.feedback,
      getKey: (feedback) => feedback.id,
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/companies/${companyId}/feedback/${mutation.key}`, {
            method: "DELETE",
          });
        }
      },
    })
  )
);
