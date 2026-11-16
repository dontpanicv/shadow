import { queryOptions } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import type { CompanyKey, LinearFeedStatus } from "../app/types.ts";

export function linearKeyQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "linear", "key"],
    queryFn: ({ signal }) =>
      request<{ key: CompanyKey | null }>(
        `/companies/${companyId}/integrations/linear/company-key`,
        { signal }
      ),
  });
}

export function linearFeedQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "linear", "feed"],
    queryFn: ({ signal }) =>
      request<LinearFeedStatus>(`/companies/${companyId}/linear`, { signal }),
  });
}
