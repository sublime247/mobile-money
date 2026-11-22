/**
 * Registration point for cron-scheduled (as opposed to interval-repeat)
 * BullMQ jobs (#2372). Each job still owns its own queue/worker pair
 * (`floatReconciliationQueue.ts` + `floatReconciliationWorker.ts`, following
 * the existing `providerBalanceAlertQueue.ts` + `providerBalanceAlertWorker.ts`
 * pattern) — this module only starts the worker and enqueues the repeat job
 * for each, so app startup has one place that lists every cron job rather
 * than scattering `start*Worker()`/`schedule*Job()` pairs across `index.ts`.
 */
import { startFloatReconciliationWorker } from "./floatReconciliationWorker";
import { scheduleFloatReconciliationJob } from "./floatReconciliationQueue";

export async function startScheduledJobs(): Promise<void> {
  startFloatReconciliationWorker();
  await scheduleFloatReconciliationJob();
}

export { startFloatReconciliationWorker, scheduleFloatReconciliationJob };
