import { describe, expect, it } from "vitest";
import {
  announcementFor,
  evaluate,
  INITIAL_STATE,
  type LadderConfig,
  type ProbeState,
} from "../src/evaluator";
import { worst } from "../src/types";

const cfg: LadderConfig = {
  failures_to_degraded: 2,
  failures_to_down: 3,
  successes_to_up: 2,
};

const ok = { ok: true, slow: false };
const slow = { ok: true, slow: true };
const fail = { ok: false, slow: false };

function run(
  samples: Array<typeof ok>,
  probe: "livez" | "readyz" | "healthz",
  from: ProbeState = INITIAL_STATE,
): ProbeState {
  return samples.reduce((s, sample) => evaluate(s, sample, probe, cfg), from);
}

describe("escalation ladder (livez/readyz)", () => {
  it("cold start: first clean success asserts UP", () => {
    expect(run([ok], "readyz").status).toBe("UP");
  });

  it("cold start: failures escalate without ever claiming UP", () => {
    expect(run([fail], "readyz").status).toBe("UNKNOWN");
    expect(run([fail, fail], "readyz").status).toBe("DEGRADED");
    expect(run([fail, fail, fail], "readyz").status).toBe("DOWN");
  });

  it("UP + 1 fail stays UP (blip tolerance)", () => {
    expect(run([ok, fail], "readyz").status).toBe("UP");
  });

  it("UP + 2 fails → DEGRADED", () => {
    expect(run([ok, fail, fail], "readyz").status).toBe("DEGRADED");
  });

  it("UP + 3 fails → DOWN, and stays DOWN while failing", () => {
    expect(run([ok, fail, fail, fail], "readyz").status).toBe("DOWN");
    expect(run([ok, fail, fail, fail, fail], "readyz").status).toBe("DOWN");
  });

  it("a success mid-ladder resets the failure count", () => {
    const s = run([ok, fail, ok, fail], "readyz");
    expect(s.status).toBe("UP");
    expect(s.consecutiveFailures).toBe(1);
  });

  it("recovery from DOWN needs 2 consecutive successes", () => {
    const down = run([ok, fail, fail, fail], "readyz");
    expect(evaluate(down, ok, "readyz", cfg).status).toBe("DOWN");
    expect(run([ok], "readyz", evaluate(down, ok, "readyz", cfg)).status).toBe("UP");
  });

  it("recovery from DEGRADED needs 2 consecutive successes", () => {
    const degraded = run([ok, fail, fail], "readyz");
    expect(evaluate(degraded, ok, "readyz", cfg).status).toBe("DEGRADED");
    expect(run([ok, ok], "readyz", degraded).status).toBe("UP");
  });

  it("goes straight DOWN → UP, no staircase", () => {
    const down = run([ok, fail, fail, fail], "readyz");
    const recovered = run([ok, ok], "readyz", down);
    expect(recovered.status).toBe("UP");
  });
});

describe("healthz DEGRADED ceiling", () => {
  it("3+ consecutive healthz failures cap at DEGRADED, never DOWN", () => {
    expect(run([ok, fail, fail, fail], "healthz").status).toBe("DEGRADED");
    expect(run([ok, fail, fail, fail, fail, fail], "healthz").status).toBe("DEGRADED");
  });
});

describe("worst()", () => {
  it("empty input is UNKNOWN, never UP", () => {
    expect(worst([])).toBe("UNKNOWN");
  });

  it("ranks DOWN > DEGRADED > UNKNOWN > UP", () => {
    expect(worst(["UP", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worst(["UP", "DEGRADED", "UNKNOWN"])).toBe("DEGRADED");
    expect(worst(["DOWN", "DEGRADED"])).toBe("DOWN");
  });
});

describe("announcementFor (against last ANNOUNCED status)", () => {
  it("skips when unchanged or current is UNKNOWN", () => {
    expect(announcementFor("UP", "UP")).toBe("skip");
    expect(announcementFor("DOWN", "UNKNOWN")).toBe("skip");
    expect(announcementFor(undefined, "UNKNOWN")).toBe("skip");
  });

  it("cold start onto UP reconciles silently (resolves stranded incidents)", () => {
    expect(announcementFor(undefined, "UP")).toBe("reconcile");
    expect(announcementFor("UNKNOWN", "UP")).toBe("reconcile");
  });

  it("first-seen outages announce even from cold start", () => {
    expect(announcementFor(undefined, "DEGRADED")).toBe("announce");
    expect(announcementFor(undefined, "DOWN")).toBe("announce");
  });

  it("real transitions announce, including recovery and partial recovery", () => {
    expect(announcementFor("UP", "DEGRADED")).toBe("announce");
    expect(announcementFor("DEGRADED", "DOWN")).toBe("announce");
    expect(announcementFor("DOWN", "DEGRADED")).toBe("announce");
    expect(announcementFor("DOWN", "UP")).toBe("announce");
  });

  it("a component passing through UNKNOWN still announces recovery (announced state is sticky)", () => {
    // DEGRADED announced → cycle with UNKNOWN (skip, announced stays DEGRADED)
    // → cycle with UP: DEGRADED→UP announces.
    expect(announcementFor("DEGRADED", "UNKNOWN")).toBe("skip");
    expect(announcementFor("DEGRADED", "UP")).toBe("announce");
  });
});

describe("slowness", () => {
  it("one slow success on an UP probe stays UP", () => {
    expect(run([ok, slow], "readyz").status).toBe("UP");
  });

  it("2 consecutive slow successes → DEGRADED, never DOWN", () => {
    expect(run([ok, slow, slow], "readyz").status).toBe("DEGRADED");
    expect(run([ok, slow, slow, slow, slow], "readyz").status).toBe("DEGRADED");
  });

  it("a fast success clears persistent slowness", () => {
    expect(run([ok, slow, slow, ok, ok], "readyz").status).toBe("UP");
  });

  it("slow successes still reset the failure ladder", () => {
    const s = run([ok, fail, fail, slow], "readyz");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.status).toBe("DEGRADED"); // still awaiting confirmed recovery
  });
});
