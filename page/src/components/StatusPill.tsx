import { Pill } from "@wardnet/ui";
import type { Status } from "../api/types";

const VARIANT: Record<Status, "ok" | "warn" | "down" | "ghost"> = {
  UP: "ok",
  DEGRADED: "warn",
  DOWN: "down",
  UNKNOWN: "ghost",
};

const LABEL: Record<Status, string> = {
  UP: "Operational",
  DEGRADED: "Degraded",
  DOWN: "Down",
  UNKNOWN: "No data",
};

export function StatusPill({ status, label }: { status: Status; label?: string }) {
  return <Pill variant={VARIANT[status]}>{label ?? LABEL[status]}</Pill>;
}
