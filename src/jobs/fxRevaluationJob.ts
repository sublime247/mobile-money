/**
 * Period-end FX Revaluation Job
 *
 * Schedule: 03:00 UTC on the 1st of each month (after daily settlement and
 * partner commission), revaluing foreign float as of the previous month end.
 * Cron env: FX_REVALUATION_CRON (default "0 3 1 * *")
 */

import { fxRevaluationService } from "../services/fxRevaluationService";

export async function runFxRevaluationJob(): Promise<void> {
  const summary = await fxRevaluationService.runRevaluation();
  const posted = summary.records.filter((r) => r.status === "posted").length;
  const failed = summary.records.filter((r) => r.status === "failed").length;

  console.log(
    `[fx-revaluation] period ${summary.periodEnd}: posted=${posted} failed=${failed} ` +
      `netUnrealizedUSD=${summary.netUnrealizedDeltaUsd.toFixed(2)}`,
  );

  if (failed > 0) {
    throw new Error(
      `[fx-revaluation] ${failed} float revaluation(s) failed for ${summary.periodEnd}: ` +
        summary.issues.join("; "),
    );
  }
}
