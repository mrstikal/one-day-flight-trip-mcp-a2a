"use client";

import type { PublicConversationMessage } from "@odft/contracts";
import { InterpretationCard } from "./interpretation-card";

/** Persisted conversation transcript (user, assistant, and system notices). */
export function MessageList({
  messages,
}: {
  readonly messages: readonly PublicConversationMessage[];
}): React.JSX.Element {
  if (messages.length === 0) {
    return (
      <p role="note" className="text-sm text-ink-muted">
        No messages yet. Describe a change in plain language and it will be queued as one operation.
      </p>
    );
  }
  return (
    <ol
      data-testid="conversation-messages"
      className="flex max-h-[340px] min-h-[340px] flex-col gap-3 overflow-y-auto pr-1"
    >
      {[...messages].reverse().map((message) => (
        <li
          key={message.id}
          data-message-id={message.id}
          data-message-role={message.role}
          data-operation-id={message.operationId ?? ""}
          className={
            message.role === "user"
              ? "self-end rounded bg-cream px-3 py-2 text-sm"
              : "self-start rounded border border-border px-3 py-2 text-sm"
          }
        >
          <p className="whitespace-pre-wrap" data-testid="conversation-message-content">
            {message.content}
          </p>
          {message.interpretation ? (
            <InterpretationCard interpretation={message.interpretation} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
