import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Inbox } from "../app/types.ts";
import { inboxQuery } from "../companies/data.ts";

/** Marks one notification read, or all of the company's without `id`. */
export async function readNotifications(
  companyId: string,
  id?: string
): Promise<void> {
  const inbox = await request<Inbox>(
    `/companies/${companyId}/notifications/read`,
    { method: "POST", body: id ? { id } : {} }
  );
  queryClient.setQueryData(inboxQuery(companyId).queryKey, inbox);
}
