import { describe, expect, it } from "vitest";
import { AgentName } from "./names.js";
import { ClientFrame, RelayFrame, parseFrame } from "./wire.js";

const id = "3f1c2a5e-8d4b-4c6f-9a1e-2b7d5c8e9f01";

describe("AgentName", () => {
  it.each(["api", "api-1", "9lives"])("accepts %s", (name) => {
    expect(AgentName.safeParse(name).success).toBe(true);
  });

  it.each(["", "API", "-api", "a b", "a".repeat(64)])("rejects %j", (name) => {
    expect(AgentName.safeParse(name).success).toBe(false);
  });
});

describe("parseFrame", () => {
  const envelope = { v: 1, copies: { ["k".repeat(43)]: "sealed" } };

  it("parses a valid client frame", () => {
    const frame = parseFrame(
      ClientFrame,
      JSON.stringify({ type: "send", id, to: "api", envelope }),
    );
    expect(frame).toEqual({ type: "send", id, to: "api", envelope });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseFrame(ClientFrame, "{nope")).toBeUndefined();
  });

  it("returns undefined for an unknown frame type", () => {
    expect(
      parseFrame(ClientFrame, JSON.stringify({ type: "shout" })),
    ).toBeUndefined();
  });

  it("rejects a plaintext message or an envelope with no copies", () => {
    expect(
      parseFrame(
        ClientFrame,
        JSON.stringify({ type: "send", id, to: "api", body: "hi" }),
      ),
    ).toBeUndefined();
    expect(
      parseFrame(
        ClientFrame,
        JSON.stringify({
          type: "send",
          id,
          to: "api",
          envelope: { v: 1, copies: {} },
        }),
      ),
    ).toBeUndefined();
  });

  it("parses a deliver frame from the relay", () => {
    const message = {
      id,
      from: "web",
      to: "api",
      envelope,
      receivedAt: "2026-10-01T12:00:00.000Z",
    };
    expect(
      parseFrame(RelayFrame, JSON.stringify({ type: "deliver", message })),
    ).toEqual({ type: "deliver", message });
  });
});
