import { useLiveQuery } from "@tanstack/react-db";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Feedback } from "../app/types.ts";
import { PanelHeader } from "../companies/shell.tsx";
import { Button, Empty } from "../ui/components.tsx";
import { day } from "../ui/format.ts";
import { Icon, type IconName } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { feedbackOf } from "./data.ts";

const route = getRouteApi("/signed-in/c/$companyId/feedback");

const KINDS: Record<Feedback["kind"], { label: string; icon: IconName }> = {
  error: { label: "Error", icon: "info" },
  missing: { label: "Missing", icon: "plus" },
  better: { label: "Better way", icon: "forward" },
};

/** What the agents reported about Shadow, newest first; a report opens its thread when the admin sees it. */
export function FeedbackPage() {
  const { companyId } = route.useParams();
  const { data: reports = [], isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ feedback: feedbackOf(companyId) })
        .orderBy(({ feedback }) => feedback.createdAt, "desc"),
  });
  return (
    <section className="conversation">
      <PanelHeader title="Feedback" />
      <div className="page">
        <div className="page-content">
          {isReady && reports.length === 0 ? (
            <Empty title="No feedback" />
          ) : (
            <div className="search-results">
              {reports.map((feedback) => (
                <FeedbackRow
                  companyId={companyId}
                  feedback={feedback}
                  key={feedback.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FeedbackRow({
  companyId,
  feedback,
}: {
  companyId: string;
  feedback: Feedback;
}) {
  const kind = KINDS[feedback.kind];
  const body = (
    <>
      <Icon name={kind.icon} />
      <span className="search-text">
        <strong>{feedback.summary}</strong>
        <span>
          {feedback.tool ? `${kind.label} · ${feedback.tool}` : kind.label}
        </span>
        <span>{feedback.detail}</span>
      </span>
      <span className="meta">{day(feedback.createdAt)}</span>
    </>
  );
  return (
    <div className="file-row">
      {feedback.threadId ? (
        <Link
          className="search-row list-row"
          params={{ companyId, threadId: feedback.threadId }}
          to="/c/$companyId/thread/$threadId"
        >
          {body}
        </Link>
      ) : (
        <div className="search-row list-row">{body}</div>
      )}
      <Button
        icon="check"
        label="Dismiss"
        onClick={() =>
          feedbackOf(companyId)
            .delete(feedback.id)
            .isPersisted.promise.catch(showError)
        }
        size="icon"
        variant="ghost"
      />
    </div>
  );
}
