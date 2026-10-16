import {
  END,
  Overwrite,
  Send,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  harnessStateSchema,
  type HarnessDomainResult,
} from "./state.js";
import { researchDomainNode, type HarnessContext } from "./test-domain-node.js";
import { awaitDecisionNode } from "./interrupt.js";

/**
 * Test-only durable harness graph (Phase 05 section 5).
 *
 * START -> begin -> (Send fan-out | await_decision) -> research_domain* ->
 * join_research -> await_decision -> finish -> END.
 *
 * It proves the keyed reducer, the single interrupt, the `Send` fan-out with a
 * single static edge into the join, the serial `Overwrite` reset, and re-entry.
 * It calls no LLM and no provider.
 */

type HarnessState = typeof harnessStateSchema.State;
type HarnessUpdate = typeof harnessStateSchema.Update;

/** Serial `begin` node: resets per-operation scope via `Overwrite` and sets run scope. */
function beginNode(state: HarnessState): HarnessUpdate {
  const isNewRun = state.operationKind === "start" || state.operationKind === "command";
  const update: HarnessUpdate = {
    stateSchemaVersion: "harness-state-v1",
    graphVersion: "harness-graph-v0",
    researchRunId: state.operationId,
    requiredDomains: state.requiredDomains,
    pendingDecisionRef: null,
    decisionKind: state.decisionKind ?? null,
    lastOutcome: null,
  };
  if (isNewRun) {
    // Serial-node Overwrite: reducer maps persist across invocations, so `{}`
    // does NOT clear them. Only a serial node may deliberately reset the scope.
    update.researchResults = new Overwrite({}) as NonNullable<
      HarnessUpdate["researchResults"]
    >;
  }
  return update;
}

/** Zero domains routes directly to the next serial node; otherwise `Send` fan-out. */
export function routeAfterBegin(state: HarnessState): string | Send[] {
  if (state.requiredDomains.length === 0) {
    return "await_decision";
  }
  return state.requiredDomains.map(
    (domain) =>
      new Send("research_domain", {
        domain,
        researchRunId: state.researchRunId,
        operationId: state.operationId,
      }),
  );
}

/** Single static-edge join: verify every scheduled key exists (ordering is irrelevant). */
function joinResearchNode(state: HarnessState): HarnessUpdate {
  for (const domain of state.requiredDomains) {
    const key = `${state.researchRunId}:${domain}`;
    if (!(key in state.researchResults)) {
      throw new Error(`join_research: missing scheduled result ${key}`);
    }
  }
  const merged: Record<string, HarnessDomainResult> = { ...state.researchResults };
  return { researchResults: merged };
}

function finishNode(): HarnessUpdate {
  return {};
}

export interface BuildHarnessGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
}

export function buildHarnessGraph(options: BuildHarnessGraphOptions) {
  const builder = new StateGraph(harnessStateSchema)
    .addNode("begin", beginNode)
    .addNode("research_domain", researchDomainNode)
    .addNode("join_research", joinResearchNode)
    .addNode("await_decision", awaitDecisionNode)
    .addNode("finish", finishNode)
    .addEdge(START, "begin")
    .addConditionalEdges("begin", routeAfterBegin)
    .addEdge("research_domain", "join_research")
    .addEdge("join_research", "await_decision")
    .addEdge("await_decision", "finish")
    .addEdge("finish", END);

  return builder.compile({ checkpointer: options.checkpointer });
}

export type { HarnessContext };
