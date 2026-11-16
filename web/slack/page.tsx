import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { PanelHeader } from "../companies/shell.tsx";
import { Badge, Empty } from "../ui/components.tsx";
import { dayTime } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { ambientTurnsQuery } from "./data.ts";

const route = getRouteApi("/signed-in/c/$companyId/ambient");

const OUTCOMES: Record<string, string> = {
  replied: "Replied",
  quiet: "Stayed quiet",
  failed: "Failed",
};

/** Each time Shadow joined a channel's conversation on its own, newest first; a row opens its Shadow thread. */
export function AmbientPage() {
  const { companyId } = route.useParams();
  const { data: turns } = useQuery(ambientTurnsQuery(companyId));
  return (
    <section className="conversation">
      <PanelHeader title="Ambient" />
      <div className="page">
        <div className="page-content">
          {turns?.length === 0 ? <Empty title="Nothing yet" /> : null}
          <div className="search-results">
            {turns?.map((turn) => (
              <Link
                className="search-row list-row"
                key={`${turn.threadId}-${turn.at}`}
                params={{ companyId, threadId: turn.threadId }}
                to="/c/$companyId/thread/$threadId"
              >
                <Icon name="hand" />
                <span className="search-text">
                  <strong>{turn.threadTitle}</strong>
                  <span>#{turn.channelName}</span>
                  <span>{turn.reason}</span>
                </span>
                <Badge label={OUTCOMES[turn.outcome] ?? turn.outcome} />
                <span className="meta">{dayTime(turn.at)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
