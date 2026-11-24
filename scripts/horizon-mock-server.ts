import {
  createHorizonMockApp,
  setHorizonChaos,
  HorizonOutageMode,
} from "../src/mocks/horizonMockServer";

const DEFAULT_PORT = Number.parseInt(process.env.HORIZON_MOCK_PORT || "8000", 10);
const DEFAULT_OUTAGE_MODE = (process.env.HORIZON_MOCK_OUTAGE || "none") as HorizonOutageMode;
const DEFAULT_DELAY_MS = Number.parseInt(process.env.HORIZON_MOCK_DELAY_MS || "0", 10);

setHorizonChaos({
  outageMode: DEFAULT_OUTAGE_MODE,
  delayMs: DEFAULT_DELAY_MS,
});

const app = createHorizonMockApp();

const server = app.listen(DEFAULT_PORT, "0.0.0.0", () => {
  console.log(`🚀 Mock Horizon Server running at http://localhost:${DEFAULT_PORT}`);
  console.log(`   Mode: ${DEFAULT_OUTAGE_MODE}`);
  console.log(`   Delay: ${DEFAULT_DELAY_MS}ms`);
  console.log(`   Endpoints: / (root), /accounts/:id, /transactions, /fee_stats, /paths/strict-receive`);
});

process.on("SIGINT", () => {
  console.log("Shutting down mock Horizon server...");
  server.close(() => {
    process.exit(0);
  });
});
