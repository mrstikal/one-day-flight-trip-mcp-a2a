import { describe, expect, it } from "vitest";
import { projectSafeEvent } from "@odft/persistence";

/**
 * T-UT-VOICE-12 (VOICE_CONTROLL.md section 15): the message event whitelist
 * stores only `{ messageId, sequence, role }` and drops text, interpretation,
 * keys, provider payloads, and unknown fields.
 */

describe("conversation.message_added event whitelist", () => {
  it("keeps exactly the safe delivery metadata", () => {
    const projected = projectSafeEvent("conversation.message_added", {
      messageId: "11111111-1111-4111-8111-111111111111",
      sequence: 3,
      role: "user",
      content: "secret travel text",
      interpretation: { intent: "select_flight" },
      result: { offerId: "offer-1" },
      operationId: "22222222-2222-4222-8222-222222222222",
      apiKey: "sk-secret",
      headers: { authorization: "Bearer secret" },
    });
    expect(projected).toEqual({
      messageId: "11111111-1111-4111-8111-111111111111",
      sequence: 3,
      role: "user",
    });
  });

  it("drops non-object payloads, unknown fields, and unknown types", () => {
    expect(projectSafeEvent("conversation.message_added", "content")).toEqual({});
    expect(projectSafeEvent("conversation.message_added", null)).toEqual({});
    expect(projectSafeEvent("conversation.message_added", ["content"])).toEqual({});
    expect(projectSafeEvent("voice.made_up", { text: "content" })).toEqual({});
  });
});
