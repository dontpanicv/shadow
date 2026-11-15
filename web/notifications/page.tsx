import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Notification } from "../app/types.ts";
import { inboxQuery } from "../companies/data.ts";
import { PanelHeader } from "../companies/shell.tsx";
import { Button, Empty } from "../ui/components.tsx";
import { day } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { readNotifications } from "./data.ts";

const route = getRouteApi("/signed-in/c/$companyId/inbox");

/** The company's notifications, newest first, as Linear's Inbox: a click reads one and opens its thread or channel. */
export function InboxPage() {
  const { companyId } = route.useParams();
  const { data: inbox } = useQuery(inboxQuery(companyId));
  return (
    <section className="conversation">
      <PanelHeader title="Inbox">
        <Button
          disabled={!inbox?.unread}
          icon="check"
          label="Mark all read"
          onClick={() => readNotifications(companyId).catch(showError)}
          size="icon"
          variant="ghost"
        />
      </PanelHeader>
      <div className="page">
        <div className="page-content">
          {inbox?.notifications.length === 0 ? (
            <Empty title="No notifications" />
          ) : (
            <div className="search-results">
              {inbox?.notifications.map((notification) => (
                <InboxRow
                  companyId={companyId}
                  key={notification.id}
                  notification={notification}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function InboxRow({
  companyId,
  notification,
}: {
  companyId: string;
  notification: Notification;
}) {
  const unread = notification.readAt === null;
  const onClick = () => {
    if (unread) {
      readNotifications(companyId, notification.id).catch(showError);
    }
  };
  const body = (
    <>
      <Icon name={notification.threadId ? "compose" : "hash"} />
      <span className="search-text">
        <strong>{notification.title}</strong>
        <span>{notification.text}</span>
      </span>
      <span className="meta">{day(notification.createdAt)}</span>
      {unread ? (
        <span aria-label="Unread" className="unread" role="img" />
      ) : (
        <span aria-hidden className="unread is-read" />
      )}
    </>
  );
  return notification.threadId ? (
    <Link
      className="search-row inbox-row list-row"
      onClick={onClick}
      params={{ companyId, threadId: notification.threadId }}
      to="/c/$companyId/thread/$threadId"
    >
      {body}
    </Link>
  ) : (
    <Link
      className="search-row inbox-row list-row"
      onClick={onClick}
      params={{ companyId, channelId: notification.channelId }}
      to="/c/$companyId/channel/$channelId"
    >
      {body}
    </Link>
  );
}
