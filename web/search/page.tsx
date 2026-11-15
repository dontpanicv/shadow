import { useLiveQuery } from "@tanstack/react-db";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { fileHref, request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type {
  Modality,
  RecentSearch,
  SearchKind,
  SearchResponse,
  SearchResult,
} from "../app/types.ts";
import { channelsOf, useMe } from "../companies/data.ts";
import { FloatingSidebarButton } from "../companies/shell.tsx";
import { Empty } from "../ui/components.tsx";
import { previewLink } from "../ui/file-preview.tsx";
import { day, dayTime } from "../ui/format.ts";
import { Icon, type IconName } from "../ui/icon.tsx";

const KIND_ICONS: Record<SearchKind, IconName> = {
  thread: "compose",
  artifact: "artifact",
  note: "file",
  file: "file",
  capture: "inbox",
};
const MEDIA_ICONS: Partial<Record<Modality, IconName>> = {
  image: "photo",
  audio: "sound",
};

// The Markdown renderer loads on its own, once a search shows results.
const Snippet = lazy(() => import("./snippet.tsx"));

const route = getRouteApi("/signed-in/c/$companyId/search");

function searchesQuery(companyId: string) {
  return queryOptions({
    queryKey: ["companies", companyId, "searches"],
    queryFn: ({ signal }) =>
      request<{ searches: RecentSearch[] }>(
        `/companies/${companyId}/searches`,
        { signal }
      ),
  });
}

/** Saves a search the person acted on or that found something; the list of recent searches is only a help, so a failure stays quiet. */
function saveSearch(companyId: string, query: string): void {
  if (!query.trim()) {
    return;
  }
  request<{ searches: RecentSearch[] }>(`/companies/${companyId}/searches`, {
    method: "POST",
    body: { query },
  })
    .then((saved) =>
      queryClient.setQueryData(searchesQuery(companyId).queryKey, saved)
    )
    .catch(() => undefined);
}

/** Search across one company: results update as you type. Before a query, the person's recent searches show, then Shadow. */
export function SearchPage() {
  const { companyId } = route.useParams();
  const { q = "" } = route.useSearch();
  const navigate = route.useNavigate();
  const [query, setQuery] = useState(q);
  const debounced = useDebouncedValue(query, 200);
  useEffect(() => {
    navigate({ search: { q: debounced || undefined }, replace: true });
  }, [debounced, navigate]);
  const company = useMe().companies.find(
    (candidate) => candidate.id === companyId
  );
  const { data: channels = [] } = useLiveQuery({
    query: (builder) => builder.from({ channel: channelsOf(companyId) }),
  });
  const { data: recent } = useQuery(searchesQuery(companyId));
  const { data: response, isPlaceholderData } = useQuery({
    queryKey: ["companies", companyId, "search", debounced],
    queryFn: ({ signal }) =>
      request<SearchResponse>(
        `/companies/${companyId}/search?q=${encodeURIComponent(debounced)}`,
        { signal }
      ),
    enabled: debounced.trim() !== "",
    placeholderData: keepPreviousData,
    gcTime: 0,
  });
  // A search counts once its results rest a second, so the words typed on the way to it do not.
  useEffect(() => {
    if (query !== debounced || isPlaceholderData || !response?.results.length) {
      return;
    }
    const timer = setTimeout(() => saveSearch(companyId, debounced), 1000);
    return () => clearTimeout(timer);
  }, [query, debounced, isPlaceholderData, response, companyId]);
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  return (
    <section className="conversation">
      <FloatingSidebarButton />
      <div className="page">
        <div className="page-content search">
          <label className="search-box">
            <Icon name="search" />
            <input
              aria-label="Search"
              autoComplete="off"
              autoFocus
              className="input large"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveSearch(companyId, query);
                }
              }}
              placeholder={`Search ${company?.name ?? ""}`}
              type="search"
              value={query}
            />
          </label>
          {query.trim() && response ? (
            <div
              className="search-results"
              onClickCapture={(event) => {
                if ((event.target as Element).closest("a.search-row")) {
                  saveSearch(companyId, query);
                }
              }}
            >
              {response.semantic ? null : (
                <p className="muted search-mode">
                  Matching words only while the search model starts.
                </p>
              )}
              {response.results.length > 0 ? (
                response.results.map((result) => (
                  <ResultRow
                    channelName={
                      result.channelId ? names.get(result.channelId) : undefined
                    }
                    companyId={companyId}
                    key={result.uri}
                    result={result}
                  />
                ))
              ) : (
                <Empty title="Nothing found" />
              )}
            </div>
          ) : null}
          {query.trim() ? null : (
            <div className="search-results">
              {recent?.searches.map((search) => (
                <button
                  className="list-row"
                  key={search.query}
                  onClick={() => setQuery(search.query)}
                  type="button"
                >
                  <Icon name="clock" />
                  <span className="name">{search.query}</span>
                  <span className="meta">{dayTime(search.searchedAt)}</span>
                </button>
              ))}
              <Link
                className="list-row"
                params={{ companyId }}
                to="/c/$companyId/orchestrator"
              >
                <Icon name="shadow" />
                <span className="name">Shadow</span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ResultRow({
  companyId,
  result,
  channelName,
}: {
  companyId: string;
  result: SearchResult;
  channelName: string | undefined;
}) {
  const when = day(result.updatedAt);
  const place = result.channelId
    ? `#${channelName ?? "channel"} · ${when}`
    : when;
  const body = (
    <>
      <Icon name={MEDIA_ICONS[result.modality] ?? KIND_ICONS[result.kind]} />
      <span className="search-text">
        <strong>{result.title}</strong>
        {result.snippet ? (
          <Suspense fallback={<span>{result.snippet}</span>}>
            <Snippet text={result.snippet} />
          </Suspense>
        ) : null}
      </span>
      <span className="meta">{place}</span>
    </>
  );
  const target = resultTarget(result);
  if (target.kind === "artifact") {
    // An artifact opens in its channel, or in the orchestrator when it is the company's own.
    return target.channelId ? (
      <Link
        className="search-row list-row"
        params={{ companyId, channelId: target.channelId }}
        search={{ artifact: target.id }}
        to="/c/$companyId/channel/$channelId"
      >
        {body}
      </Link>
    ) : (
      <Link
        className="search-row list-row"
        params={{ companyId }}
        search={{ artifact: target.id }}
        to="/c/$companyId/orchestrator"
      >
        {body}
      </Link>
    );
  }
  if (target.kind === "file") {
    return (
      <a
        className="search-row list-row"
        {...previewLink([{ href: fileHref(companyId, target.id) }], 0)}
      >
        {body}
      </a>
    );
  }
  if (target.kind === "thread") {
    return (
      <Link
        className="search-row list-row"
        params={{ companyId, threadId: target.id }}
        to="/c/$companyId/thread/$threadId"
      >
        {body}
      </Link>
    );
  }
  return <div className="search-row list-row">{body}</div>;
}

/** What a result opens: an artifact, a file that Shadow saved, a thread, or nothing. */
export function resultTarget(
  result: Pick<SearchResult, "kind" | "uri" | "channelId" | "threadId">
):
  | { kind: "artifact"; id: string; channelId: string | null }
  | { kind: "file" | "thread"; id: string }
  | { kind: "none" } {
  if (result.kind === "artifact") {
    return {
      kind: "artifact",
      id: result.uri.slice("artifact:".length),
      channelId: result.channelId,
    };
  }
  const file = /^(?:channels\/[^/]+\/)?files\/([0-9a-f-]{36})-/.exec(
    result.uri
  );
  if (file) {
    return { kind: "file", id: file[1]! };
  }
  return result.threadId
    ? { kind: "thread", id: result.threadId }
    : { kind: "none" };
}

function useDebouncedValue<Value>(value: Value, milliseconds: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);
  return settled;
}
