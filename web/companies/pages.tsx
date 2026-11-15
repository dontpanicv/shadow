import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { Empty } from "../ui/components.tsx";
import {
  channelsOf,
  lastOpened,
  orchestratorQuery,
  threadsOf,
  useMe,
} from "./data.ts";
import { FloatingSidebarButton, Shell } from "./shell.tsx";

/** The app opens on the company; a person who is not a member yet waits for an admin to add them. */
export function Home() {
  const { companies } = useMe();
  const last = lastOpened();
  const company =
    companies.find((candidate) => candidate.id === last?.companyId) ??
    companies[0];
  return company ? (
    <Navigate params={{ companyId: company.id }} replace to="/c/$companyId" />
  ) : (
    <Shell companyId={undefined}>
      <section className="conversation">
        <FloatingSidebarButton />
        <Empty title="Ask a family member to add you" />
      </section>
    </Shell>
  );
}

const companyRoute = getRouteApi("/signed-in/c/$companyId/");

/** A company opens on the channel or thread this browser had open last, if it still exists, else on the orchestrator. */
export function CompanyHome() {
  const { companyId } = companyRoute.useParams();
  const channels = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(companyId) }),
  });
  const threads = useLiveQuery({
    query: (q) => q.from({ thread: threadsOf(companyId) }),
  });
  const orchestrator = useQuery(orchestratorQuery(companyId)).data;
  if (!(channels.isReady && threads.isReady && orchestrator)) {
    return null;
  }
  const last = lastOpened();
  if (last?.companyId === companyId) {
    if (channels.data.some((channel) => channel.id === last.channelId)) {
      return (
        <Navigate
          params={{ companyId, channelId: last.channelId! }}
          replace
          to="/c/$companyId/channel/$channelId"
        />
      );
    }
    if (
      last.threadId === orchestrator.id ||
      threads.data.some((thread) => thread.id === last.threadId)
    ) {
      return (
        <Navigate
          params={{ companyId, threadId: last.threadId! }}
          replace
          to="/c/$companyId/thread/$threadId"
        />
      );
    }
  }
  return (
    <Navigate
      params={{ companyId, threadId: orchestrator.id }}
      replace
      to="/c/$companyId/thread/$threadId"
    />
  );
}

const orchestratorRoute = getRouteApi("/signed-in/c/$companyId/orchestrator");

/** The orchestrator's thread; a search result opens one of the company's own artifacts here. */
export function OrchestratorPage() {
  const { companyId } = orchestratorRoute.useParams();
  const search = orchestratorRoute.useSearch();
  const orchestrator = useQuery(orchestratorQuery(companyId)).data;
  return orchestrator ? (
    <Navigate
      params={{ companyId, threadId: orchestrator.id }}
      replace
      search={search}
      to="/c/$companyId/thread/$threadId"
    />
  ) : null;
}
