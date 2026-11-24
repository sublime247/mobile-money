import {
  DEFAULT_DUAL_APPROVAL_THRESHOLD_USD,
  MakerCheckerError,
  MakerCheckerService,
  createInMemoryApprovalStore,
  getDualApprovalThresholdUsd,
  requiresDualApproval,
} from "../makerCheckerService";

const MAKER = "admin-maker";
const CHECKER = "admin-checker";
const PAYLOAD = {
  accountType: "vault",
  accountId: "vault-1",
  amountXaf: 3_500_000,
  destination: "GDEST",
};

function createService() {
  let counter = 0;
  return new MakerCheckerService(
    createInMemoryApprovalStore(),
    () => new Date("2026-11-24T10:00:00.000Z"),
    () => `tap-${++counter}`,
  );
}

async function expectMakerCheckerError(
  promise: Promise<unknown>,
  code: MakerCheckerError["code"],
) {
  await expect(promise).rejects.toBeInstanceOf(MakerCheckerError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("requiresDualApproval", () => {
  it("uses a $5,000 USD default threshold", () => {
    delete process.env.TREASURY_DUAL_APPROVAL_THRESHOLD_USD;
    expect(getDualApprovalThresholdUsd()).toBe(
      DEFAULT_DUAL_APPROVAL_THRESHOLD_USD,
    );
    expect(requiresDualApproval(4_999.99)).toBe(false);
    expect(requiresDualApproval(5_000)).toBe(true);
    expect(requiresDualApproval(12_000)).toBe(true);
  });

  it("honours the environment override", () => {
    process.env.TREASURY_DUAL_APPROVAL_THRESHOLD_USD = "100";
    try {
      expect(requiresDualApproval(150)).toBe(true);
      expect(requiresDualApproval(50)).toBe(false);
    } finally {
      delete process.env.TREASURY_DUAL_APPROVAL_THRESHOLD_USD;
    }
  });

  it("fails closed when the USD amount cannot be determined", () => {
    expect(requiresDualApproval(Number.NaN)).toBe(true);
  });
});

describe("MakerCheckerService", () => {
  it("parks a large withdrawal in PENDING_APPROVAL on initiation", async () => {
    const service = createService();

    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    expect(request).toMatchObject({
      id: "tap-1",
      status: "PENDING_APPROVAL",
      makerId: MAKER,
      amountUsd: 6_000,
      createdAt: "2026-11-24T10:00:00.000Z",
    });
    expect(await service.getRequest("tap-1")).toMatchObject({
      status: "PENDING_APPROVAL",
    });
  });

  it("rejects self-approval by the initiating admin", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    await expectMakerCheckerError(
      service.approve(request.id, { userId: MAKER, roles: ["TREASURY_ADMIN"] }),
      "SELF_APPROVAL",
    );
    expect((await service.getRequest(request.id))?.status).toBe(
      "PENDING_APPROVAL",
    );
  });

  it("requires a distinct TREASURY_ADMIN to approve", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    await expectMakerCheckerError(
      service.approve(request.id, { userId: CHECKER, roles: ["ADMIN"] }),
      "NOT_TREASURY_ADMIN",
    );
  });

  it("approves a request by a distinct treasury admin", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    const approved = await service.approve(request.id, {
      userId: CHECKER,
      roles: ["TREASURY_ADMIN"],
    });

    expect(approved).toMatchObject({
      status: "APPROVED",
      makerId: MAKER,
      checkerId: CHECKER,
      payload: PAYLOAD,
    });
  });

  it("does not allow a second approval once the request is resolved", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });
    await service.approve(request.id, {
      userId: CHECKER,
      roles: ["TREASURY_ADMIN"],
    });

    await expectMakerCheckerError(
      service.approve(request.id, {
        userId: "admin-third",
        roles: ["TREASURY_ADMIN"],
      }),
      "NOT_PENDING",
    );
  });

  it("lets the maker cancel a pending request", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    const cancelled = await service.cancel(
      request.id,
      MAKER,
      "wrong destination",
    );

    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      cancelReason: "wrong destination",
    });
    await expectMakerCheckerError(
      service.approve(request.id, {
        userId: CHECKER,
        roles: ["TREASURY_ADMIN"],
      }),
      "NOT_PENDING",
    );
  });

  it("rejects cancellation by anyone other than the maker", async () => {
    const service = createService();
    const request = await service.initiate({
      makerId: MAKER,
      amountUsd: 6_000,
      payload: PAYLOAD,
    });

    await expectMakerCheckerError(
      service.cancel(request.id, CHECKER, "not mine"),
      "NOT_MAKER",
    );
    expect((await service.getRequest(request.id))?.status).toBe(
      "PENDING_APPROVAL",
    );
  });

  it("reports unknown request ids", async () => {
    const service = createService();
    await expectMakerCheckerError(
      service.approve("missing", {
        userId: CHECKER,
        roles: ["TREASURY_ADMIN"],
      }),
      "NOT_FOUND",
    );
    await expectMakerCheckerError(
      service.cancel("missing", MAKER, "x"),
      "NOT_FOUND",
    );
    expect(await service.getRequest("missing")).toBeNull();
  });

  it("refuses initiation without a maker identity", async () => {
    const service = createService();
    await expectMakerCheckerError(
      service.initiate({ makerId: "", amountUsd: 6_000, payload: PAYLOAD }),
      "NOT_MAKER",
    );
  });
});
