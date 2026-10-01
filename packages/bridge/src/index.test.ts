import { describe, expect, it } from "vitest";
import { ENVELOPE_VERSION } from "@blether/protocol";
import { bridgeEnvelopeVersion } from "./index.js";

describe("bridge", () => {
  it("speaks the protocol's envelope version", () => {
    expect(bridgeEnvelopeVersion).toBe(ENVELOPE_VERSION);
  });
});
