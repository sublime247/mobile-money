import express from "express";
import request from "supertest";
import {
  refreshStellarWalletMetrics,
  stellarWalletBaseReserveUtilizationPercent,
  stellarWalletReserveBytes,
  stellarWalletSequenceNumber,
  stellarWalletSubentriesTotal,
  stellarWalletXlmBalance,
} from "../stellarCollector";
import { register } from "../../utils/metrics";
import { createMetricsRouter } from "../../routes/metrics";

describe("Stellar wallet metrics collector", () => {
  afterEach(() => {
    delete process.env.STELLAR_HOT_WALLET_PUBLIC_KEY;
    delete process.env.STELLAR_FEE_ACCOUNT_PUBLIC_KEY;
  });

  it("registers wallet metrics and emits labeled Prometheus scrape output", async () => {
    process.env.STELLAR_HOT_WALLET_PUBLIC_KEY = "G-HOT";
    process.env.STELLAR_FEE_ACCOUNT_PUBLIC_KEY = "G-FEE";
    stellarWalletSequenceNumber.reset();
    stellarWalletReserveBytes.reset();
    stellarWalletBaseReserveUtilizationPercent.reset();
    stellarWalletXlmBalance.reset();
    stellarWalletSubentriesTotal.reset();

    const server = {
      loadAccount: jest.fn(async (publicKey: string) => ({
        sequence: publicKey === "G-HOT" ? "42" : "90",
        subentry_count: 2,
        balances: [{ asset_type: "native", balance: "10.0000000" }],
      })),
    };

    await refreshStellarWalletMetrics(server);
    const exposition = await register.metrics();

    expect(server.loadAccount).toHaveBeenCalledTimes(2);
    expect(exposition).toContain(
      'stellar_wallet_sequence_number{role="hot_wallet"} 42',
    );
    expect(exposition).toContain(
      'stellar_wallet_xlm_balance{role="fee_account"} 10',
    );
    expect(exposition).toContain(
      'stellar_wallet_subentries_total{role="hot_wallet"} 2',
    );
    expect(exposition).toContain(
      'stellar_wallet_reserve_bytes{role="hot_wallet"} 512',
    );
    expect(exposition).toContain(
      'stellar_wallet_base_reserve_utilization_percent{role="hot_wallet"} 20',
    );
  });

  it("serves /metrics without waiting for an in-progress Horizon refresh", async () => {
    process.env.STELLAR_HOT_WALLET_PUBLIC_KEY = "G-HOT";
    let completeAccountLoad!: (account: {
      sequence: string;
      subentry_count: number;
      balances: Array<{ asset_type: string; balance: string }>;
    }) => void;
    const refresh = refreshStellarWalletMetrics({
      loadAccount: () =>
        new Promise((resolve) => {
          completeAccountLoad = resolve;
        }),
    });
    const app = express();
    app.use(
      "/metrics",
      createMetricsRouter({ authEnabled: false, internalOnly: false }),
    );

    await request(app)
      .get("/metrics")
      .expect(200)
      .then((response) => {
        expect(response.text).toContain("# HELP stellar_wallet_xlm_balance");
      });

    completeAccountLoad({
      sequence: "43",
      subentry_count: 0,
      balances: [{ asset_type: "native", balance: "1" }],
    });
    await refresh;
  });
});
