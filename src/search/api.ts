import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Search in one company, and the person's recent searches there. */
export const searchApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/companies/:company/search",
    api(async ({ app, user, params, request }) => {
      // Membership first: a company's index is only ever searched by its members.
      const company = app.companies.requireMember(params.company!, user);
      const url = new URL(request.url);
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit")) || 20, 1),
        50
      );
      return json(
        await app.indexer.search(
          company.id,
          url.searchParams.get("q") ?? "",
          limit,
          user.id
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/companies/:company/searches",
    api(async ({ app, user, params }) => {
      const company = app.companies.requireMember(params.company!, user);
      return json({
        searches: app.recentSearches.list(company.id, user.id),
      });
    }),
  ],
  [
    "POST",
    "/api/v1/companies/:company/searches",
    api(async ({ app, user, params, body }) => {
      const company = app.companies.requireMember(params.company!, user);
      return json({
        searches: app.recentSearches.add(company.id, user.id, body.query),
      });
    }),
  ],
];
