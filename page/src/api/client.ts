import type { HistoryResponse, IncidentsResponse, StatusResponse } from "./types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchStatus = () => get<StatusResponse>("/api/status");
export const fetchHistory = () => get<HistoryResponse>("/api/history");
export const fetchIncidents = () => get<IncidentsResponse>("/api/incidents");
