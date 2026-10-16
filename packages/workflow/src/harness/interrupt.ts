import { interrupt, InvalidUpdateError } from "@langchain/langgraph";
import { graphResumeEnvelopeSchema } from "@odft/contracts";
import { harnessStateSchema } from "./state.js";

/** Options the harness decision offers; a resume may only select one of these. */
export const HARNESS_ALLOWED_OPTION_IDS = ["continue"] as const;

/**
 * The single generic interrupt node for the harness. It has NO side effects and
 * no counters before the interrupt (03-langgraph-design.md section 7). On resume
 * it applies the trusted {@link GraphResumeEnvelope} operation identity/revision
 * into serial state, so any later effect is keyed by the new operation. A
 * `choose_option` response that is not one of the offered options is rejected
 * rather than silently accepted.
 */
export async function awaitDecisionNode(
  state: typeof harnessStateSchema.State,
): Promise<typeof harnessStateSchema.Update> {
  const descriptor = {
    kind: state.decisionKind ?? "clarification",
    pendingDecisionRef: state.pendingDecisionRef,
    allowedOptionIds: [...HARNESS_ALLOWED_OPTION_IDS],
  };
  const resume = interrupt(descriptor, { responseSchema: graphResumeEnvelopeSchema });
  const envelope = graphResumeEnvelopeSchema.parse(resume);
  if (
    envelope.response.action === "choose_option" &&
    !HARNESS_ALLOWED_OPTION_IDS.includes(
      envelope.response.optionId as (typeof HARNESS_ALLOWED_OPTION_IDS)[number],
    )
  ) {
    throw new InvalidUpdateError(
      `option "${envelope.response.optionId}" is not offered by the pending decision`,
    );
  }
  return {
    operationId: envelope.operationId,
    acceptedRevision: envelope.acceptedRevision,
    pendingDecisionRef: null,
    decisionKind: null,
    lastOutcome: "success",
  };
}
