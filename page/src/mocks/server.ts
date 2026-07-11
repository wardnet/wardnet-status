import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** Node-side MSW server for vitest — the same handlers as the browser worker. */
export const server = setupServer(...handlers);
