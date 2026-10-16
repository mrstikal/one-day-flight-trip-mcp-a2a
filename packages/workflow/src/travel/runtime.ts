import type { TravelPorts } from "./ports.js";

/** Minimal view of the LangGraph runtime object this graph relies on. */
export interface TravelRuntime {
  readonly context?: {
    readonly operationId?: string;
    readonly ports?: TravelPorts;
  };
}

export function travelPorts(runtime: unknown): TravelPorts {
  const ports = (runtime as TravelRuntime | undefined)?.context?.ports;
  if (!ports) {
    throw new Error("travel graph nodes require TravelPorts in the invocation context");
  }
  return ports;
}
