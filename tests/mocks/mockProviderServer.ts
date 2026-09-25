// Offline mock mobile-money provider server (#1965).
//
// The actual mock implementation lives in `scripts/provider-mock-server.ts`
// and is shared by both `npm run provider-mock:dev` (a real listening
// server for local development) and the test suite
// (`tests/scripts/providerMockServer.test.ts`, `src/mocks/tests/*`). This
// file re-exports it under the path the issue asks for, plus small
// start/stop helpers for Jest setup/teardown, without duplicating the
// route logic.

import type { Server } from "http";
import {
  createProviderMockApp,
  startProviderMockServer,
} from "../../scripts/provider-mock-server";

export { createProviderMockApp, startProviderMockServer };

let runningServer: Server | undefined;

/**
 * Start the mock provider server for a Jest global setup / beforeAll hook.
 * Idempotent: calling it again while a server is already running returns
 * the existing instance instead of binding the port twice.
 */
export function startMockProviderServerForTests(port?: number): Server {
  if (runningServer) {
    return runningServer;
  }
  runningServer = startProviderMockServer(port);
  return runningServer;
}

/**
 * Stop the mock provider server started by
 * {@link startMockProviderServerForTests}, for a Jest afterAll hook.
 * A no-op if no server is currently running.
 */
export async function stopMockProviderServerForTests(): Promise<void> {
  if (!runningServer) {
    return;
  }
  const server = runningServer;
  runningServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
