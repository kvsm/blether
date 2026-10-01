import { describe, expect, it } from "vitest";
import { ENVELOPE_VERSION } from "./index.js";

describe("protocol", () => {
  it("starts at envelope version 1", () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});
