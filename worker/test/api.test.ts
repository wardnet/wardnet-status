import { describe, expect, it } from "vitest";
import { intParam } from "../src/api";

describe("intParam (untrusted query params)", () => {
  it("uses the fallback for garbage", () => {
    expect(intParam("abc", 48, 336)).toBe(48);
    expect(intParam("NaN", 48, 336)).toBe(48);
    expect(intParam("Infinity", 48, 336)).toBe(48);
  });

  it("clamps into [1, max]", () => {
    expect(intParam("0", 48, 336)).toBe(1);
    expect(intParam("-5", 48, 336)).toBe(1);
    expect(intParam("9999", 48, 336)).toBe(336);
    expect(intParam("24.9", 48, 336)).toBe(24);
  });

  it("missing param → fallback", () => {
    expect(intParam(null, 90, 365)).toBe(90);
  });
});
