import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { WorkingSpinner } from "../ui/components.tsx";

/** A link that opens a thread, and its spinner while the thread's agent works. */
export function ThreadLink({
  companyId,
  threadId,
  children,
}: {
  companyId: string;
  threadId: string;
  children: ReactNode;
}) {
  return (
    <>
      <Link
        className="thread-link"
        params={{ companyId, threadId }}
        to="/c/$companyId/thread/$threadId"
      >
        {children}
      </Link>
      <WorkingSpinner threadId={threadId} />
    </>
  );
}
