import { describe, expect, it } from "vitest";
import { Send } from "@langchain/langgraph";
import { InvalidUpdateError } from "@langchain/langgraph";
import { researchResultsValue, routeAfterBegin } from "@odft/workflow";

/**
 * T-IT-RED-01/02: keyed reducer semantics and single-mechanism serial routing.
 */

type Result = { domain: string; status: "ok"; fingerprint: string; attempts: number };

function result(domain: string, fingerprint: string): Result {
  return { domain, status: "ok", fingerprint, attempts: 1 };
}

describe("keyed reducer map", () => {
  const reduce = researchResultsValue.reducer as (
    current: Record<string, Result>,
    next: Record<string, Result>,
  ) => Record<string, Result>;

  it("RED-01: merges unique keys", () => {
    const merged = reduce({ "run:hotel": result("hotel", "a") }, { "run:dinner": result("dinner", "b") });
    expect(Object.keys(merged).sort()).toEqual(["run:dinner", "run:hotel"]);
  });

  it("RED-01: replaces an equal key only with the identical result", () => {
    const merged = reduce(
      { "run:hotel": result("hotel", "a") },
      { "run:hotel": result("hotel", "a") },
    );
    expect(merged["run:hotel"]?.fingerprint).toBe("a");
  });

  it("RED-01: rejects conflicting same-key results", () => {
    expect(() =>
      reduce(
        { "run:hotel": result("hotel", "a") },
        { "run:hotel": result("hotel", "DIFFERENT") },
      ),
    ).toThrow(InvalidUpdateError);
  });

  it("RED-01: result ordering is not meaningful", () => {
    const a = reduce({}, { "run:hotel": result("hotel", "a"), "run:dinner": result("dinner", "b") });
    const b = reduce({}, { "run:dinner": result("dinner", "b"), "run:hotel": result("hotel", "a") });
    const normalize = (map: Record<string, Result>) =>
      Object.keys(map)
        .sort()
        .map((key) => [key, map[key]]);
    expect(normalize(a)).toEqual(normalize(b));
  });
});

describe("serial routing", () => {
  function state(requiredDomains: string[]) {
    return { requiredDomains, researchRunId: "run", operationId: "op" } as never;
  }

  it("RED-02: zero domains routes straight to the next serial node", () => {
    expect(routeAfterBegin(state([]))).toBe("await_decision");
  });

  it("RED-02: affected domains fan out with Send only", () => {
    const routes = routeAfterBegin(state(["hotel", "dinner"]));
    expect(Array.isArray(routes)).toBe(true);
    expect((routes as Send[]).every((send) => send instanceof Send)).toBe(true);
    expect(routes).toHaveLength(2);
  });
});
