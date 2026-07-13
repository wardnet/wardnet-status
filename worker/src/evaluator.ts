import type { Status } from "./types";

/**
 * The agreed status ladder (see CONTEXT.md "Status"):
 *   consecutive failures: 1 → UP (blip tolerance), 2 → DEGRADED, 3+ → DOWN
 *   (default thresholds; overridable per assertion in the Topology Config)
 *   recovery: 2 consecutive successes → straight back to UP
 * Severity ceilings come from the assertion's declared impact: "down" walks the
 * full ladder; "degraded" caps at DEGRADED (the other assertions passing proves
 * the component is serving). Slow-but-successful responses contribute DEGRADED
 * only, via the same failures_to_degraded threshold.
 */

export interface LadderConfig {
  failures_to_degraded: number;
  failures_to_down: number;
  successes_to_up: number;
  impact: "down" | "degraded";
}

export interface ProbeState {
  status: Status;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  consecutiveSlow: number;
}

export interface ProbeSample {
  /** 2xx within timeout. */
  ok: boolean;
  /** ok but latency above degraded_latency_ms. */
  slow: boolean;
}

export const INITIAL_STATE: ProbeState = {
  status: "UNKNOWN",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  consecutiveSlow: 0,
};

function capped(status: Status, impact: LadderConfig["impact"]): Status {
  if (status === "DOWN" && impact === "degraded") return "DEGRADED";
  return status;
}

/**
 * Announcement policy, evaluated against the last ANNOUNCED component status
 * (persisted in DO storage), not the previous cycle's computed status — so a
 * transition survives a failed side-effect and retries next cycle
 * (at-least-once), and a component passing through UNKNOWN cannot strand an
 * open incident.
 *
 * - "skip": nothing to do (current UNKNOWN, or already announced)
 * - "announce": run incidents + notifications, then adopt as announced
 * - "reconcile": cold start landing on UP — resolve any stale open incident
 *   (notify only if one was actually resolved), then adopt silently
 */
export function announcementFor(
  announced: Status | undefined,
  current: Status,
): "skip" | "announce" | "reconcile" {
  if (current === "UNKNOWN") return "skip";
  if (announced === current) return "skip";
  if (announced === undefined || announced === "UNKNOWN") {
    return current === "UP" ? "reconcile" : "announce";
  }
  return "announce";
}

export function evaluate(
  state: ProbeState,
  sample: ProbeSample,
  cfg: LadderConfig,
): ProbeState {
  if (!sample.ok) {
    const failures = state.consecutiveFailures + 1;
    let status: Status;
    if (failures >= cfg.failures_to_down) status = "DOWN";
    else if (failures >= cfg.failures_to_degraded) status = "DEGRADED";
    // A single blip never worsens the standing status, but from UNKNOWN
    // (cold start) it stays UNKNOWN rather than asserting UP.
    else status = state.status === "UNKNOWN" ? "UNKNOWN" : state.status;
    return {
      status: capped(status, cfg.impact),
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      consecutiveSlow: 0,
    };
  }

  const successes = state.consecutiveSuccesses + 1;
  const slowCount = sample.slow ? state.consecutiveSlow + 1 : 0;

  let status: Status;
  if (slowCount >= cfg.failures_to_degraded) {
    // Persistent slowness: serving, but badly. Never worse than DEGRADED.
    status = "DEGRADED";
  } else if (state.status === "UP" || state.status === "UNKNOWN") {
    // First clean success from cold start asserts UP immediately; an isolated
    // slow success on an UP probe stays UP until slowness persists.
    status = "UP";
  } else {
    // Recovering from DEGRADED/DOWN: require confirmed recovery.
    status = successes >= cfg.successes_to_up ? "UP" : state.status;
  }

  return {
    status,
    consecutiveFailures: 0,
    consecutiveSuccesses: successes,
    consecutiveSlow: slowCount,
  };
}
