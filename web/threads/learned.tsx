import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Learned } from "../app/types.ts";
import {
  channelsOf,
  membersQuery,
  orchestratorQuery,
} from "../companies/data.ts";
import {
  Button,
  Empty,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from "../ui/components.tsx";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { learnedOf } from "./data.ts";

/**
 * What Shadow learned from the threads: facts about each person, then the how-tos of each channel and of the person's
 * own Shadow. Each person corrects or deletes what they see.
 */
export function LearnedSection({ companyId }: { companyId: string }) {
  const { data: entries = [], isReady } = useLiveQuery({
    query: (q) => q.from({ entry: learnedOf(companyId) }),
  });
  const { data: channels = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channelsOf(companyId) })
        .orderBy(({ channel }) => channel.order),
  });
  const members = useQuery(membersQuery(companyId)).data ?? [];
  const orchestrator = useQuery(orchestratorQuery(companyId)).data;
  if (!isReady) {
    return <SettingsCard>{null}</SettingsCard>;
  }
  if (entries.length === 0) {
    return <Empty title="Nothing learned yet" />;
  }
  const groups = [
    ...members.map((member) => ({
      title: `About ${member.name}`,
      entries: entries.filter(
        (entry) => entry.kind === "about" && entry.personId === member.userId
      ),
    })),
    {
      title: "About former members",
      entries: entries.filter(
        (entry) =>
          entry.kind === "about" &&
          !members.some((member) => member.userId === entry.personId)
      ),
    },
    {
      title: orchestrator?.title ?? "Shadow",
      entries: entries.filter(
        (entry) => entry.kind === "howto" && entry.channelId === null
      ),
    },
    ...channels.map((channel) => ({
      title: `#${channel.name}`,
      entries: entries.filter(
        (entry) => entry.kind === "howto" && entry.channelId === channel.id
      ),
    })),
  ];
  return groups
    .filter((group) => group.entries.length > 0)
    .map((group) => (
      <LearnedGroup
        companyId={companyId}
        entries={group.entries}
        key={group.title}
        title={group.title}
      />
    ));
}

function LearnedGroup({
  companyId,
  title,
  entries,
}: {
  companyId: string;
  title: string;
  entries: readonly Learned[];
}) {
  return (
    <>
      <h3>{title}</h3>
      <SettingsCard>
        {entries.map((entry) => (
          <LearnedRow companyId={companyId} entry={entry} key={entry.id} />
        ))}
      </SettingsCard>
    </>
  );
}

/** An entry, which a click on Edit turns into a field; Enter saves it and Escape keeps the old text. */
function LearnedRow({
  companyId,
  entry,
}: {
  companyId: string;
  entry: Learned;
}) {
  const [editing, setEditing] = useState(false);
  const learned = learnedOf(companyId);
  if (editing) {
    return (
      <form
        className="settings-row compact"
        onSubmit={(event) => {
          event.preventDefault();
          const text = String(new FormData(event.currentTarget).get("text"));
          setEditing(false);
          if (text.trim() && text !== entry.text) {
            learned
              .update(entry.id, (draft) => {
                draft.text = text.trim();
              })
              .isPersisted.promise.catch(showError);
          }
        }}
      >
        <input
          aria-label="Text"
          autoFocus
          className="input learned-input"
          defaultValue={entry.text}
          name="text"
          onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
          required
        />
        <Button label="Cancel" onClick={() => setEditing(false)} size="small" />
        <Button label="Save" size="small" type="submit" variant="primary" />
      </form>
    );
  }
  return (
    <SettingsRow
      compact
      label={
        <span className="learned-text">
          {entry.text}
          {entry.realm === null ? null : (
            <Tooltip label="Private">
              <span aria-label="Private" className="lock" role="img">
                <Icon name="lock" />
              </span>
            </Tooltip>
          )}
        </span>
      }
    >
      <Button
        icon="compose"
        label="Edit"
        onClick={() => setEditing(true)}
        size="icon"
        variant="ghost"
      />
      <Button
        icon="trash"
        label="Delete"
        onClick={() =>
          learned.delete(entry.id).isPersisted.promise.catch(showError)
        }
        size="icon"
        variant="ghost"
      />
    </SettingsRow>
  );
}
