import { eq, isNull, not, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { fileHref } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { ThreadSummary } from "../app/types.ts";
import { ArtifactList, ArtifactPreview } from "../artifacts/panel.tsx";
import {
  channelsOf,
  meQuery,
  mergeChannel,
  orchestratorQuery,
  rememberOpened,
  setSettled,
  threadsOf,
} from "../companies/data.ts";
import { PanelHeader } from "../companies/shell.tsx";
import {
  Button,
  Dialog,
  Empty,
  Menu,
  WorkingSpinner,
} from "../ui/components.tsx";
import { previewLink } from "../ui/file-preview.tsx";
import { dayTime, size } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { ApprovalRequest } from "./approval.tsx";
import { Composer } from "./composer.tsx";
import {
  filesOf,
  messagesOf,
  moveThread,
  type Place,
  placeKey,
  startThread,
  stopThread,
  uploadFiles,
  useThreadStream,
} from "./data.ts";
import { continues, followEnd, MessageView } from "./message.tsx";
import { followed, outbox, sendMessage } from "./outbox.ts";

const threadRoute = getRouteApi("/signed-in/c/$companyId/thread/$threadId");

/**
 * A thread of the company in the address; a thread of another company is not found. `orchestratorCards` shows over
 * the composer of the person's orchestrator only.
 */
export function ThreadPage({
  orchestratorCards,
}: {
  orchestratorCards: ReactNode;
}) {
  const { companyId, threadId } = threadRoute.useParams();
  const orchestrator = useQuery(orchestratorQuery(companyId)).data;
  const isOrchestrator = orchestrator?.id === threadId;
  const { data: listed, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(companyId) })
        .where(({ thread: row }) => eq(row.id, threadId))
        .findOne(),
  });
  const thread = isOrchestrator ? orchestrator : listed;
  if (!thread) {
    return isReady && orchestrator ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty title="Not found" />
      </section>
    ) : null;
  }
  return (
    <Thread
      cards={isOrchestrator ? orchestratorCards : null}
      companyId={companyId}
      isOrchestrator={isOrchestrator}
      thread={thread}
      threadId={threadId}
    />
  );
}

/** A thread: its live transcript and composer, and the panel with its place's artifacts and files. */
function Thread({
  companyId,
  threadId,
  thread,
  isOrchestrator,
  cards,
}: {
  companyId: string;
  threadId: string;
  thread: ThreadSummary;
  isOrchestrator: boolean;
  /** Cards over the composer. */
  cards: ReactNode;
}) {
  const { data: channels = [] } = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(companyId) }),
  });
  const channel = channels.find(
    (candidate) => candidate.id === thread.channelId
  );
  const { data: messages = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ message: messagesOf(threadId) })
        .orderBy(({ message }) => message.time),
  });
  // The orchestrator belongs to the company, not to its channel: its files and artifacts are the company's own.
  const place: Place = {
    companyId,
    channelId: isOrchestrator ? null : thread.channelId,
  };
  const key = placeKey(place);
  const placeChanged = useDebounced(
    useCallback(
      () =>
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) => queryKey.includes(key),
        }),
      [key]
    )
  );
  const { data: waiting = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ message: outbox })
        .where(({ message }) => eq(message.threadId, threadId))
        .orderBy(({ message }) => message.time),
  });
  const { running, approvals } = useThreadStream(
    companyId,
    threadId,
    placeChanged
  );
  const me = useQuery(meQuery).data?.user.id;
  const mine = approvals.filter(
    ({ approverId }) => approverId === null || approverId === me
  );
  useEffect(() => {
    followed.add(threadId);
    return () => {
      followed.delete(threadId);
    };
  }, [threadId]);
  useEffect(
    () => rememberOpened(`/c/${companyId}/thread/${threadId}`),
    [companyId, threadId]
  );
  const settled = thread.settledAt !== null;
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            isOrchestrator ? (
              thread.title
            ) : (
              <>
                <span className="breadcrumb">{channel?.name} › </span>
                {thread.title}
              </>
            )
          }
        >
          {isOrchestrator ? null : (
            <>
              <Menu
                entries={[
                  { kind: "label", label: "Move to" },
                  ...channels.map((candidate) => ({
                    kind: "action" as const,
                    label: candidate.name,
                    icon: candidate.ownerId
                      ? ("lock" as const)
                      : ("hash" as const),
                    current: candidate.id === thread.channelId,
                    onSelect: () =>
                      moveThread(
                        companyId,
                        threadId,
                        thread.channelId,
                        candidate.id
                      ),
                  })),
                ]}
                trigger={
                  <Button
                    icon="forward"
                    label="Move thread"
                    size="icon"
                    variant="ghost"
                  />
                }
              />
              <Button
                icon={settled ? "inbox" : "check"}
                label={settled ? "Un-settle thread" : "Settle thread"}
                onClick={() => setSettled(companyId, threadId, !settled)}
                size="icon"
                variant="ghost"
              />
            </>
          )}
          <PanelToggle />
        </PanelHeader>
        <section
          aria-live="polite"
          className="transcript"
          id="transcript"
          ref={followEnd}
        >
          {messages.map((message, index) => (
            <MessageView
              companyId={companyId}
              continued={continues(message, messages[index - 1])}
              key={message.id}
              message={message}
            />
          ))}
          {mine.map((approval) => (
            <ApprovalRequest
              approval={approval}
              key={approval.id}
              threadId={threadId}
            />
          ))}
          {waiting.map((message) => (
            <MessageView
              companyId={companyId}
              key={message.id}
              message={message}
              pending
            />
          ))}
          {messages.length + waiting.length === 0 ? (
            <div className="empty">
              <strong>Ask Shadow anything</strong>
            </div>
          ) : null}
        </section>
        {cards}
        <Composer
          clearAtOnce
          onSend={(text, files) => sendMessage(threadId, text, files)}
          onStop={
            running ? () => stopThread(threadId).catch(showError) : undefined
          }
          placeholder={
            isOrchestrator
              ? "Message Shadow"
              : `Message #${channel?.name ?? ""}`
          }
        />
      </section>
      <PlacePanel place={place} />
    </>
  );
}

const channelRoute = getRouteApi("/signed-in/c/$companyId/channel/$channelId");

/**
 * A channel: its threads, settled ones folded away, in up to the top half; its details under them; and the panel with
 * the files and artifacts of all its threads.
 */
export function ChannelPage({ details }: { details: ReactNode }) {
  const { companyId, channelId } = channelRoute.useParams();
  const navigate = useNavigate();
  const [into, setInto] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const channels = channelsOf(companyId);
  const { data: channel, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channels })
        .where(({ channel: row }) => eq(row.id, channelId))
        .findOne(),
  });
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(companyId) })
        .where(({ thread }) => eq(thread.channelId, channelId))
        .where(({ thread }) => isNull(thread.settledAt))
        .orderBy(({ thread }) => thread.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(companyId) })
        .where(({ thread }) => eq(thread.channelId, channelId))
        .where(({ thread }) => not(isNull(thread.settledAt)))
        .orderBy(({ thread }) => thread.settledAt, "desc"),
  });
  useEffect(
    () => rememberOpened(`/c/${companyId}/channel/${channelId}`),
    [companyId, channelId]
  );
  if (!channel) {
    return isReady ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty title="Not found" />
      </section>
    ) : null;
  }
  // Only a private channel merges away; a channel that every member sees copies a Slack channel.
  const targets =
    channel.ownerId === null
      ? []
      : [...channels.values()].filter((other) => other.id !== channelId);
  const merge = async () => {
    if (!into) {
      return;
    }
    setBusy(true);
    try {
      await mergeChannel(companyId, channelId, into.id);
      setInto(null);
      navigate({
        to: "/c/$companyId/channel/$channelId",
        params: { companyId, channelId: into.id },
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            <>
              <span className="breadcrumb"># </span>
              {channel.name}
            </>
          }
        >
          {targets.length > 0 ? (
            <Menu
              entries={[
                { kind: "label", label: "Merge into" },
                ...targets.map((target) => ({
                  kind: "action" as const,
                  label: target.name,
                  icon: target.ownerId ? ("lock" as const) : ("hash" as const),
                  onSelect: () => setInto(target),
                })),
              ]}
              trigger={
                <Button
                  icon="forward"
                  label="Merge channel"
                  size="icon"
                  variant="ghost"
                />
              }
            />
          ) : null}
          <PanelToggle />
        </PanelHeader>
        <div className="channel">
          <div className="channel-threads">
            {active.length + settled.length > 0 ? (
              <div className="list">
                {active.map((thread) => (
                  <ThreadRow
                    companyId={companyId}
                    key={thread.id}
                    thread={thread}
                  />
                ))}
                {settled.length > 0 ? (
                  <details className="settled-threads">
                    <summary>Settled ({settled.length})</summary>
                    {settled.map((thread) => (
                      <ThreadRow
                        companyId={companyId}
                        key={thread.id}
                        thread={thread}
                      />
                    ))}
                  </details>
                ) : null}
              </div>
            ) : (
              <Empty title="No threads yet" />
            )}
          </div>
          <div className="channel-details">{details}</div>
        </div>
        <Composer
          onSend={async (text, files) => {
            const thread = await startThread(companyId, channelId, text, files);
            navigate({
              to: "/c/$companyId/thread/$threadId",
              params: { companyId, threadId: thread.id },
            });
          }}
          placeholder={`Start a thread in #${channel.name}`}
        />
        <Dialog
          busy={busy}
          onClose={() => setInto(null)}
          onSubmit={merge}
          open={into !== null}
          submit="Merge"
          title={`Merge #${channel.name} into #${into?.name ?? ""}?`}
        >
          <p>Its threads, files, artifacts, and routines move there.</p>
        </Dialog>
      </section>
      <PlacePanel place={{ companyId, channelId }} />
    </>
  );
}

function ThreadRow({
  companyId,
  thread,
}: {
  companyId: string;
  thread: {
    id: string;
    title: string;
    updatedAt: number;
    settledAt: number | null;
  };
}) {
  const settled = thread.settledAt !== null;
  return (
    <div className="file-row">
      <Link
        className="list-row"
        params={{ companyId, threadId: thread.id }}
        to="/c/$companyId/thread/$threadId"
      >
        <Icon name="compose" />
        <span className="name">{thread.title}</span>
        <WorkingSpinner threadId={thread.id} />
        <span className="meta">{dayTime(thread.updatedAt)}</span>
      </Link>
      <Button
        icon={settled ? "inbox" : "check"}
        label={settled ? "Un-settle thread" : "Settle thread"}
        onClick={() => setSettled(companyId, thread.id, !settled)}
        size="icon"
        variant="ghost"
      />
    </div>
  );
}

/** Whether the side panel shows; wide screens show it at first. A page's header toggles it. */
const panelOpen = {
  value: matchMedia("(min-width: 1001px)").matches,
  listeners: new Set<(open: boolean) => void>(),
  set(open: boolean) {
    this.value = open;
    for (const listener of this.listeners) {
      listener(open);
    }
  },
};

function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(panelOpen.value);
  useEffect(() => {
    panelOpen.listeners.add(setOpen);
    return () => {
      panelOpen.listeners.delete(setOpen);
    };
  }, []);
  return [open, (value) => panelOpen.set(value)];
}

function PanelToggle() {
  const [open, setOpen] = usePanelOpen();
  return (
    <Button
      aria-pressed={open}
      icon="panel"
      label="Artifacts"
      onClick={() => setOpen(!open)}
      size="icon"
      variant="ghost"
    />
  );
}

const placeRoute = getRouteApi("/signed-in/c/$companyId");

/**
 * The side panel of a place: its files and artifacts in tabs, and the preview of the artifact that `?artifact=` names,
 * as a list or a search result opens it.
 */
function PlacePanel({ place }: { place: Place }) {
  const [open, setOpen] = usePanelOpen();
  const [tab, setTab] = useState<"files" | "artifacts">("files");
  const { artifact } = placeRoute.useSearch({
    select: (search) => search as { artifact?: string },
  });
  const navigate = useNavigate();
  const key = placeKey(place);
  useEffect(() => {
    if (artifact) {
      panelOpen.set(true);
      // Closing the preview goes back to the artifacts it came from.
      setTab("artifacts");
    }
  }, [artifact]);
  const openArtifact = (artifactId: string | undefined) =>
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, artifact: artifactId }),
    });
  if (!open) {
    return null;
  }
  return (
    <aside aria-label="Artifacts" className="artifacts">
      <header className="panel-header">
        {artifact ? (
          <Button
            label="Close preview"
            onClick={() => openArtifact(undefined)}
            size="small"
            style={{ marginRight: "auto" }}
            variant="ghost"
          />
        ) : (
          <div className="tabs" role="tablist">
            <Tab current={tab} id="files" label="Files" onSelect={setTab} />
            <Tab
              current={tab}
              id="artifacts"
              label="Artifacts"
              onSelect={setTab}
            />
          </div>
        )}
        <Button
          icon="close"
          label="Close artifacts"
          onClick={() => setOpen(false)}
          size="icon"
          variant="ghost"
        />
      </header>
      {artifact ? (
        <ArtifactPreview
          artifactId={artifact}
          companyId={place.companyId}
          onClose={() => openArtifact(undefined)}
          placeKey={key}
        />
      ) : null}
      {!artifact && tab === "artifacts" ? (
        <ArtifactList onOpen={openArtifact} placeKey={key} />
      ) : null}
      {!artifact && tab === "files" ? <FileList place={place} /> : null}
    </aside>
  );
}

function Tab<Id extends string>({
  id,
  label,
  current,
  onSelect,
}: {
  id: Id;
  label: string;
  current: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <button
      aria-selected={current === id}
      className="tab"
      onClick={() => onSelect(id)}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

/** The files of a place, newest first, each with a delete button. Files dropped on the tab upload. */
function FileList({ place }: { place: Place }) {
  const files = filesOf(placeKey(place));
  const { data: rows = [] } = useLiveQuery({
    query: (q) =>
      q.from({ file: files }).orderBy(({ file }) => file.time, "desc"),
  });
  const previews = rows.map((file) => ({
    href: fileHref(place.companyId, file.id),
    name: file.name,
    size: file.size,
  }));
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const upload = async (picked: FileList) => {
    setBusy(true);
    try {
      await uploadFiles(place, [...picked]);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut for the upload button
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the same
    <div
      className="thread-files"
      data-dropping={dropping || undefined}
      onDragLeave={(event) =>
        event.currentTarget.contains(event.relatedTarget as Node) ||
        setDropping(false)
      }
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDrop={(event) => {
        setDropping(false);
        if (event.dataTransfer.files.length > 0) {
          event.preventDefault();
          upload(event.dataTransfer.files);
        }
      }}
    >
      <form aria-busy={busy || undefined}>
        <Button
          data-file-pick
          icon="plus"
          label="Upload files"
          onClick={() => picker.current?.click()}
        />
        <input
          hidden
          multiple
          onChange={(event) => {
            if (event.target.files) {
              upload(event.target.files);
            }
            event.target.value = "";
          }}
          ref={picker}
          type="file"
        />
      </form>
      {rows.length > 0 ? (
        <div className="list">
          {rows.map((file, index) => (
            <div className="file-row" key={file.id}>
              <a className="list-row" {...previewLink(previews, index)}>
                <Icon name="file" />
                <span className="name">{file.name}</span>
                <span className="meta">{size(file.size)}</span>
              </a>
              <Button
                icon="trash"
                label={`Delete ${file.name}`}
                onClick={() =>
                  files.delete(file.id).isPersisted.promise.catch(showError)
                }
                size="icon"
                variant="ghost"
              />
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No files yet" />
      )}
    </div>
  );
}

/** `run` once, a second after the last of a burst of calls, as a streaming answer changes many times a second. */
function useDebounced(run: () => void): () => void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, 1000);
  }, [run]);
}
