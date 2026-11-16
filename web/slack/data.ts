import { queryOptions } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import type { SlackAmbientTurn } from "../app/types.ts";

/** The turns that Shadow took on its own in the channels the person sees, newest first. */
export function ambientTurnsQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "slack", "ambient"],
    queryFn: ({ signal }) =>
      request<SlackAmbientTurn[]>(`/companies/${companyId}/slack/ambient`, {
        signal,
      }),
  });
}
