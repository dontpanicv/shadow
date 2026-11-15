import { useState } from "react";
import type { Approval } from "../app/types.ts";
import { Button } from "../ui/components.tsx";
import { showError } from "../ui/toast.tsx";
import { answerApproval } from "./data.ts";

/**
 * An action the agent waits for the person to allow or deny. It sits in the transcript after the answer that asks,
 * with its buttons at the start of the line, far from the composer's Send.
 */
export function ApprovalRequest({
  approval,
  threadId,
}: {
  approval: Approval;
  threadId: string;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    setBusy(true);
    answerApproval(threadId, approval.id, allow).catch((error) => {
      setBusy(false);
      showError(error);
    });
  };
  return (
    <div className="approval">
      <p>{approval.text}</p>
      <div className="approval-actions">
        <Button
          disabled={busy}
          label="Allow"
          onClick={() => answer(true)}
          size="small"
          variant="primary"
        />
        <Button
          disabled={busy}
          label="Deny"
          onClick={() => answer(false)}
          size="small"
          variant="danger"
        />
      </div>
    </div>
  );
}
