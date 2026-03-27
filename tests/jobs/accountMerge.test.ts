import * as StellarSdk from "stellar-sdk";
import {
  evaluateAccountMergeCandidate,
  parseAuxiliaryAccountSecrets,
  resolveMergeDestinationPublicKey,
  stroopsToXlm,
  xlmToStroops,
} from "../../src/jobs/accountMerge";

describe("accountMerge helpers", () => {
  it("parses and de-duplicates configured source secrets", () => {
    expect(parseAuxiliaryAccountSecrets("SAAA, SBBB, SAAA , ,SCCC")).toEqual([
      "SAAA",
      "SBBB",
      "SCCC",
    ]);
  });

  it("uses the explicit merge destination when provided", () => {
    const destination = StellarSdk.Keypair.random().publicKey();
    expect(resolveMergeDestinationPublicKey(destination)).toBe(destination);
  });

  it("returns null when no destination or issuer secret is configured", () => {
    expect(resolveMergeDestinationPublicKey(undefined, undefined)).toBeNull();
  });

  it("marks inactive reserve-only accounts as mergeable", () => {
    const result = evaluateAccountMergeCandidate(
      {
        nativeBalance: "2.5000000",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      30,
      new Date("2026-03-26T00:00:00.000Z"),
    );

    expect(result).toEqual({
      eligible: true,
      reclaimableBalance: "2.49999",
    });
  });

  it("rejects recently active accounts", () => {
    const result = evaluateAccountMergeCandidate(
      {
        nativeBalance: "2.5000000",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date("2026-03-20T00:00:00.000Z"),
      },
      30,
      new Date("2026-03-26T00:00:00.000Z"),
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("active within the last 30 day");
  });

  it("rejects accounts with subentries or non-native balances", () => {
    const withSubentries = evaluateAccountMergeCandidate(
      {
        nativeBalance: "2.5000000",
        subentryCount: 2,
        hasNonNativeBalances: false,
        lastActivityAt: null,
      },
      30,
      new Date("2026-03-26T00:00:00.000Z"),
    );
    const withAssets = evaluateAccountMergeCandidate(
      {
        nativeBalance: "2.5000000",
        subentryCount: 0,
        hasNonNativeBalances: true,
        lastActivityAt: null,
      },
      30,
      new Date("2026-03-26T00:00:00.000Z"),
    );

    expect(withSubentries.reason).toContain("subentries");
    expect(withAssets.reason).toContain("non-native");
  });

  it("converts XLM amounts to and from stroops", () => {
    const stroops = xlmToStroops("1.2345678");
    expect(stroops).toBe(12345678n);
    expect(stroopsToXlm(stroops)).toBe("1.2345678");
  });
});
