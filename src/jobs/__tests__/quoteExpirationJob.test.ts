import { runQuoteExpirationJob } from "../quoteExpirationJob";
import * as quoteService from "../../services/sep38/quoteService";
import logger from "../../utils/logger";

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

describe("runQuoteExpirationJob", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("calls expireStaleQuotes and logs success when quotes are swept", async () => {
    const expireSpy = jest
      .spyOn(quoteService, "expireStaleQuotes")
      .mockResolvedValueOnce(3);

    await runQuoteExpirationJob();

    expect(expireSpy).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { expiredCount: 3 },
      "[QuoteExpirationJob] Successfully swept expired SEP-38 quotes",
    );
  });

  it("logs debug when no quotes needed expiration", async () => {
    jest.spyOn(quoteService, "expireStaleQuotes").mockResolvedValueOnce(0);

    await runQuoteExpirationJob();

    expect(logger.debug).toHaveBeenCalledWith(
      "[QuoteExpirationJob] No expired SEP-38 quotes found",
    );
  });

  it("catches and logs error when sweep fails", async () => {
    const testError = new Error("DB connection failure");
    jest.spyOn(quoteService, "expireStaleQuotes").mockRejectedValueOnce(testError);

    await runQuoteExpirationJob();

    expect(logger.error).toHaveBeenCalledWith(
      { error: testError },
      "[QuoteExpirationJob] Error occurred while sweeping expired SEP-38 quotes",
    );
  });
});
