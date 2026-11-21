/**
 * `momo-cli dlq:replay` (#2448): inspect dead-lettered jobs, filter them by
 * origin queue and failure reason, and re-enqueue them into active
 * processing with their failure counters reset.
 *
 *   momo-cli dlq:replay [--queue <name>] [--error-match <text|/regex/>]
 *                       [--limit <n>] [--dry-run]
 *
 * Matching jobs (ID, failure reason, retry count, creation time) are always
 * printed before anything is re-enqueued; `--dry-run` stops after printing.
 *
 * This module holds the argument parsing, rendering and control flow only.
 * The queue operations are injected (see src/queue/dlq.ts and the wiring in
 * src/scripts/momo-cli.ts), so this package doesn't depend on BullMQ/Redis
 * and the logic can be unit tested with fakes.
 */

export interface DlqReplayCliOptions {
  queue?: string;
  errorMatch?: string;
  limit?: number;
  dryRun: boolean;
}

/** Structural copy of `DlqEntry` from src/queue/dlq.ts. */
export interface DlqReplayEntry {
  dlqJobId: string;
  originalJobId?: string;
  queueName: string;
  failedReason: string;
  retryCount: number;
  createdAt: Date;
}

export type DlqReplayStatus = "retried" | "requeued" | "skipped" | "error";

export interface DlqReplayOutcome {
  status: DlqReplayStatus;
  jobId?: string;
  message?: string;
}

export interface DlqReplayDeps<J = unknown> {
  list(filter: {
    queue?: string;
    errorMatch?: string;
    limit?: number;
  }): Promise<Array<{ entry: DlqReplayEntry; job: J }>>;
  replay(entry: DlqReplayEntry, job: J): Promise<DlqReplayOutcome>;
}

export interface DlqReplayIo {
  log(line: string): void;
  error(line: string): void;
}

export const DEFAULT_DLQ_REPLAY_LIMIT = 50;
const MAX_REASON_WIDTH = 60;

export const DLQ_REPLAY_USAGE =
  "Usage: momo-cli dlq:replay [--queue <name>] [--error-match <text|/regex/>] [--limit <n>] [--dry-run]";

export class DlqReplayArgError extends Error {}

/** Parse CLI flags. Accepts both `--flag value` and `--flag=value`. */
export function parseDlqReplayArgs(argv: string[]): DlqReplayCliOptions {
  const options: DlqReplayCliOptions = {
    dryRun: false,
    limit: DEFAULT_DLQ_REPLAY_LIMIT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new DlqReplayArgError(`Missing value for ${flag}`);
      }
      return value;
    };

    switch (flag) {
      case "--queue":
        options.queue = takeValue();
        break;
      case "--error-match":
        options.errorMatch = takeValue();
        break;
      case "--limit": {
        const raw = takeValue();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new DlqReplayArgError(`--limit must be a positive integer (got "${raw}")`);
        }
        options.limit = n;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new DlqReplayArgError(`Unknown option ${arg}`);
        }
    }
  }

  if (options.errorMatch?.startsWith("/")) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(options.errorMatch);
    try {
      if (!m) throw new Error("unterminated");
      new RegExp(m[1], m[2]);
    } catch {
      throw new DlqReplayArgError(`Invalid --error-match regex ${options.errorMatch}`);
    }
  }

  return options;
}

function truncate(text: string, width: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > width ? `${single.slice(0, width - 3)}...` : single;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const render = (cells: string[]) =>
    widths.map((w, c) => (cells[c] ?? "").padEnd(w)).join(" | ").trimEnd();
  return [render(headers), widths.map((w) => "-".repeat(w)).join("-+-"), ...rows.map(render)].join("\n");
}

/** Table of job ID, queue, failure reason, retry count and creation time. */
export function formatDlqEntries(entries: DlqReplayEntry[]): string {
  return table(
    ["Job ID", "Queue", "Failed Reason", "Retries", "Created At"],
    entries.map((e) => [
      e.originalJobId ?? e.dlqJobId,
      e.queueName,
      truncate(e.failedReason, MAX_REASON_WIDTH),
      String(e.retryCount),
      e.createdAt.toISOString(),
    ]),
  );
}

export interface DlqReplayRunResult {
  matched: number;
  replayed: number;
  skipped: number;
  failed: number;
  exitCode: number;
}

/** Execute `dlq:replay`: list, print, then (unless dry-run) replay. */
export async function runDlqReplay<J>(
  options: DlqReplayCliOptions,
  deps: DlqReplayDeps<J>,
  io: DlqReplayIo = { log: console.log, error: console.error },
): Promise<DlqReplayRunResult> {
  const selected = await deps.list({
    queue: options.queue,
    errorMatch: options.errorMatch,
    limit: options.limit,
  });

  const filters = [
    options.queue && `queue=${options.queue}`,
    options.errorMatch && `error-match=${options.errorMatch}`,
    `limit=${options.limit ?? "none"}`,
  ]
    .filter(Boolean)
    .join(", ");

  if (selected.length === 0) {
    io.log(`No dead-lettered jobs match (${filters}).`);
    return { matched: 0, replayed: 0, skipped: 0, failed: 0, exitCode: 0 };
  }

  io.log(`Found ${selected.length} dead-lettered job(s) (${filters}):\n`);
  io.log(formatDlqEntries(selected.map((s) => s.entry)));
  io.log("");

  if (options.dryRun) {
    io.log(`Dry run: ${selected.length} job(s) would be re-enqueued. Nothing was changed.`);
    return { matched: selected.length, replayed: 0, skipped: 0, failed: 0, exitCode: 0 };
  }

  let replayed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { entry, job } of selected) {
    const id = entry.originalJobId ?? entry.dlqJobId;
    const outcome = await deps.replay(entry, job);
    switch (outcome.status) {
      case "retried":
      case "requeued":
        replayed++;
        io.log(`  ✓ ${id} ${outcome.status} on ${entry.queueName} (attempts reset)`);
        break;
      case "skipped":
        skipped++;
        io.log(`  - ${id} skipped: ${outcome.message ?? "not eligible"}`);
        break;
      default:
        failed++;
        io.error(`  ✗ ${id} failed: ${outcome.message ?? "unknown error"}`);
    }
  }

  io.log(`\nReplayed ${replayed}, skipped ${skipped}, failed ${failed} of ${selected.length}.`);
  return {
    matched: selected.length,
    replayed,
    skipped,
    failed,
    exitCode: failed > 0 ? 1 : 0,
  };
}
