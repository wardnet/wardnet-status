import { fireEvent, render, screen } from "@testing-library/react";
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
    // Same service exists in several regions — one card per region.
    expect(screen.getAllByText("DDNS").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Tunneller").length).toBeGreaterThan(1);
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

  it("service details are collapsed by default and expand on demand", async () => {
    useScenario("operational");
    render(<App />);
    await screen.findByText("All systems operational");
    // Collapsed: no per-service incident story visible inside region cards.
    expect(screen.queryByText("Incidents")).not.toBeInTheDocument();

    // First toggle belongs to the first service row (global / Tenants).
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.getByText("Incidents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument();
  });

  it("incident history lists resolved incidents with their GitHub issue", async () => {
    useScenario("operational");
    render(<App />);
    expect(await screen.findByText("Incident history")).toBeInTheDocument();
    expect(screen.getByText("issue #12")).toHaveAttribute(
      "href",
      "https://github.com/wardnet/wardnet-status/issues/12",
    );
  });

  it("incident description is behind a toggle and shows the request details", async () => {
    useScenario("operational");
    render(<App />);
    await screen.findByText("Incident history");
    expect(screen.queryByText(/Requests behind this evaluation/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "description" }));
    expect(screen.getByText(/Requests behind this evaluation/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });
});
