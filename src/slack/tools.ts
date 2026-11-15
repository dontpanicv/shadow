import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Companies } from "../companies/companies.ts";
import type { Notifications } from "../notifications/notifications.ts";

/**
 * The tool that tells one member something privately: a notification in their inbox, which also reaches them as a
 * Slack DM. An ambient turn uses it when one person needs to know what a channel did not ask of everyone.
 */
export function noticeTools(
  companies: Pick<Companies, "agentMember" | "members" | "threadOf">,
  notifications: Pick<Notifications, "notify">,
  companyId: string
) {
  return [
    defineTool({
      name: "notices_tell",
      description:
        "Tell one member of the company something privately, in their inbox and as a Slack DM, with a link to this thread. Use it when one person needs to know, and the channel does not.",
      parameters: Type.Object({
        person: Type.String({
          description: "The member's name or email, as members list it",
        }),
        text: Type.String({ maxLength: 2000 }),
      }),
      replay: "safe",
      execute: (args, api) => {
        const thread = companies.threadOf(companyId, api.conversationId);
        const wanted = args.person.trim().toLowerCase();
        const member = companies
          .members(companyId, companies.agentMember(companyId))
          .find(
            (candidate) =>
              candidate.email.toLowerCase() === wanted ||
              candidate.name.toLowerCase() === wanted
          );
        if (!(thread && member)) {
          throw new Error(
            `No member is ${args.person}; name a member exactly, or use their email.`
          );
        }
        notifications.notify({
          id: `notice:${api.taskId}:${member.userId}`,
          companyId,
          userId: member.userId,
          channelId: thread.channelId,
          threadId: thread.id,
          title: "From Shadow",
          text: args.text,
        });
        return Promise.resolve({
          output: [{ type: "text", text: `Told ${member.name}.` }],
        });
      },
    }),
  ];
}
