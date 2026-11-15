import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useRef } from "react";
import { signOut } from "../accounts/login.tsx";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import { lastOpened, meQuery, useMe } from "../companies/data.ts";
import {
  CompanySection,
  FactsSection,
  MembersSection,
  SlackBotSection,
} from "../companies/settings.tsx";
import { FloatingSidebarButton, Shell } from "../companies/shell.tsx";
import { IntegrationsSection } from "../integrations/section.tsx";
import { LlmCard, llmQuery } from "../llm/card.tsx";
import { UsageSection } from "../llm/usage.tsx";
import { PlacesSection } from "../places/section.tsx";
import { LearnedSection } from "../threads/learned.tsx";
import {
  Avatar,
  Button,
  Empty,
  PageContent,
  PageSection,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { showError, showToast } from "../ui/toast.tsx";

const companyRoute = getRouteApi("/signed-in/c/$companyId/settings");

/** The company's Slack bot, members, facts, what Shadow learned, and name; only its admins open it. */
export function CompanySettingsPage() {
  const { companyId } = companyRoute.useParams();
  const company = useMe().companies.find(
    (candidate) => candidate.id === companyId
  )!;
  return (
    <section className="conversation">
      <FloatingSidebarButton />
      {company.role === "admin" ? (
        <PageContent title={company.name}>
          <PageSection title="Slack">
            <SlackBotSection companyId={companyId} />
          </PageSection>
          <PageSection title="Members">
            <MembersSection company={company} />
          </PageSection>
          <PageSection title="Facts">
            <FactsSection companyId={companyId} />
          </PageSection>
          <PageSection title="What Shadow learned">
            <LearnedSection companyId={companyId} />
          </PageSection>
          <PageSection title="Company">
            <CompanySection company={company} />
          </PageSection>
        </PageContent>
      ) : (
        <Empty title="Only an admin opens company settings" />
      )}
    </section>
  );
}

/** The person's integrations, places, usage, the LLM provider, and the account, most used first. The sidebar keeps the last company, so settings feel like part of the app. */
export function SettingsPage() {
  const { user, companies } = useMe();
  const { data: llm } = useQuery(llmQuery);
  const last = lastOpened();
  const company =
    companies.find((candidate) => candidate.id === last?.companyId) ??
    companies[0];
  return (
    <Shell companyId={company?.id}>
      <section className="conversation">
        <FloatingSidebarButton />
        <PageContent title="Settings">
          {company ? (
            <>
              <PageSection title="Integrations">
                <IntegrationsSection companyId={company.id} />
              </PageSection>
              <PageSection title="Places">
                <PlacesSection companyId={company.id} />
              </PageSection>
              <PageSection title="Usage">
                <UsageSection companyId={company.id} />
              </PageSection>
            </>
          ) : null}
          <PageSection title="LLM provider">
            <LlmCard />
          </PageSection>
          {llm?.admin ? (
            <PageSection title="Server">
              <SettingsCard>
                <SettingsRow label="Configuration">
                  <Button label="Reload" onClick={reload} />
                </SettingsRow>
              </SettingsCard>
            </PageSection>
          ) : null}
          <PageSection title="Account">
            <SettingsCard>
              <SettingsRow
                description={user.email}
                label={user.name}
                lead={<Avatar name={user.name} picture={user.picture} />}
              >
                <PictureButtons picture={user.picture} />
              </SettingsRow>
              <SettingsRow
                description="Sign out of Shadow on this device."
                label="Sign out"
              >
                <Button label="Sign out" onClick={() => signOut()} />
              </SettingsRow>
            </SettingsCard>
          </PageSection>
        </PageContent>
      </section>
    </Shell>
  );
}

/** The longest side of a profile picture that the app uploads, in pixels. */
const PICTURE_SIZE = 256;

/** Uploads or removes the person's profile picture, which every member then sees. */
function PictureButtons({ picture }: { picture: string | null }) {
  const picker = useRef<HTMLInputElement>(null);
  const change = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) {
        return request("/me/picture", { method: "DELETE" });
      }
      const body = new FormData();
      body.append("picture", await squarePicture(file), "picture.jpg");
      return request("/me/picture", { method: "POST", body });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[2] === "members",
        }),
      ]),
    onError: showError,
  });
  return (
    <>
      {picture ? (
        <Button
          disabled={change.isPending}
          label="Remove picture"
          onClick={() => change.mutate(null)}
          variant="ghost"
        />
      ) : null}
      <Button
        disabled={change.isPending}
        label="Upload picture"
        onClick={() => picker.current?.click()}
      />
      <input
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            change.mutate(file);
          }
          event.target.value = "";
        }}
        ref={picker}
        type="file"
      />
    </>
  );
}

/** The middle square of a picture as a small JPEG, so every app shows it round and the upload stays small. */
async function squarePicture(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Shadow cannot read this picture");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(side, PICTURE_SIZE);
  const canvas = new OffscreenCanvas(size, size);
  canvas
    .getContext("2d")!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size
    );
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
}

/** Restarts Shadow, which then reads config/shadow.toml again. */
async function reload() {
  try {
    await request("/server/restart", { method: "POST" });
    showToast("success", "Shadow restarts");
  } catch (error) {
    showError(error);
  }
}
