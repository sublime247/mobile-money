import { describe, expect, it, beforeEach } from "@jest/globals";
import {
  TransactionModel,
  TransactionStatus,
  ALLOWED_STATUS_TRANSITIONS,
} from "../../models/transaction";

describe("TransactionModel Status Race Condition & State Transitions", () => {
  let transactionModel: TransactionModel;

  beforeEach(() => {
    transactionModel = new TransactionModel();
  });

  it("should define allowed state transition rules correctly", () => {
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Pending]).toContain(
      TransactionStatus.Processing,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Pending]).toContain(
      TransactionStatus.Completed,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Pending]).toContain(
      TransactionStatus.Failed,
    );

    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Processing]).toContain(
      TransactionStatus.Completed,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Processing]).toContain(
      TransactionStatus.Failed,
    );

    // Terminal/final states cannot regress back to pending or processing
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Completed]).not.toContain(
      TransactionStatus.Pending,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Completed]).not.toContain(
      TransactionStatus.Processing,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Failed]).not.toContain(
      TransactionStatus.Pending,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Failed]).not.toContain(
      TransactionStatus.Processing,
    );
    expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.Cancelled]).not.toContain(
      TransactionStatus.Completed,
    );
  });
});
