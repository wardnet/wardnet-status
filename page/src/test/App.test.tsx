import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { buildScenario } from "../mocks/scenarios";
import { server } from "../mocks/server";

function useScenario(name: Parameters<typeof buildScenario>[0]) {
  const s = buildScenario(name);
  server.use(
    http.get("/api/status", () => HttpResponse.json(s.status)),
    http.get("/api/history", () => HttpResponse.json(s.history)),
    http.get("/api/incidents", () => HttpResponse.json({ incidents: s.incidents })),
  );
}

describe("status page", () => {
  it("operational: shows the all-clear and every component", async () => {
    useScenario("operational");
    render(<App />);
    expect(await screen.findByText("All systems operational")).toBeInTheDocument();
    expect(screen.getByText("Tenants (accounts & identity)")).toBeInTheDocument();
    expect(screen.getByText("DDNS")).toBeInTheDocument();
    expect(screen.getByText("Tunneller")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("degraded: warns without declaring an outage", async () => {
    useScenario("degraded");
    render(<App />);
    expect(await screen.findByText("Partial degradation")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("tunneller (use1)");
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
  });

  it("down: shows the outage banner and the DOWN pill", async () => {
    useScenario("down-incident");
    render(<App />);
    expect(await screen.findByText("Service outage")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ddns (use1)");
    expect(screen.getAllByText("Down").length).toBeGreaterThan(0);
  });

  it("stale config: surfaces the staleness warning", async () => {
    useScenario("stale-config");
    render(<App />);
    expect(
      await screen.findByText(/topology is stale/i),
    ).toBeInTheDocument();
  });

  it("cold start: reports awaiting probes, never a fake all-clear", async () => {
    useScenario("cold-start");
    render(<App />);
    expect(await screen.findByText("Awaiting first probes")).toBeInTheDocument();
    expect(screen.queryByText("All systems operational")).not.toBeInTheDocument();
    expect(screen.getAllByText("Collecting…").length).toBeGreaterThan(0);
  });

  it("incident history lists resolved incidents with their GitHub issue", async () => {
    useScenario("operational");
    render(<App />);
    expect(await screen.findByText("Incident history")).toBeInTheDocument();
    expect(screen.getByText("#12")).toHaveAttribute(
      "href",
      "https://github.com/wardnet/wardnet-status/issues/12",
    );
  });
});
