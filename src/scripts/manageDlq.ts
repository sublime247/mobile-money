/**
 * Operator CLI for failed merchant webhooks (webhook retry dead letter queue).
 *
 *   npm run queue:dlq:list                        summarise failures by merchant
 *   npm run queue:dlq:retry -- --merchant <id>    re-queue one merchant's failures
 *   npm run queue:dlq:retry -- --all              re-queue every failure
 *   npm run queue:dlq:purge -- --merchant <id>    delete dead jobs (asks first)
 *
 * Shared flags: --error-match <text|/regex/flags>, --limit <n>, --dry-run.
 * `purge` also accepts --yes to skip the confirmation prompt.
 */
import readline from "readline";
import {
  listWebhookDlq,
  purgeWebhookDlq,
  replayWebhookDlq,
  summarizeWebhookDlq,
  WebhookDlqFilter,
  WebhookDlqQueue,
} from "../queue/webhookDlqService";

export type DlqCommand = "list" | "retry" | "purge";

export interface ManageDlqArgs {
  command?: DlqCommand;
  merchant?: string;
  all: boolean;
  errorMatch?: string;
  limit?: number;
  dryRun: boolean;
  yes: boolean;
}

export interface ManageDlqDeps {
  queue?: WebhookDlqQueue;
  /** Returns true when the operator confirms a destructive action. */
  confirm?: (question: string) => Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Whether stdin is interactive; without it, purge needs --yes. */
  interactive?: boolean;
}

const USAGE = `Usage: manage-dlq <list|retry|purge> [options]

Options:
  --merchant <id>        only failures owned by this merchant ID
  --all                  required for retry/purge when --merchant is not given
  --error-match <text>   case-insensitive substring or /regex/flags on the error
  --limit <n>            process at most n entries (oldest first)
  --dry-run              report what would change without changing it
  --yes                  skip the purge confirmation prompt
`;

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Parse CLI arguments. Throws on unknown flags or invalid values. */
export function parseManageDlqArgs(argv: string[]): ManageDlqArgs {
  const args: ManageDlqArgs = { all: false, dryRun: false, yes: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "list":
      case "retry":
      case "purge":
        if (args.command) throw new Error(`Unexpected extra command "${token}"`);
        args.command = token;
        break;
      case "--merchant":
        args.merchant = readValue(argv, i, token).trim();
        if (!args.merchant) throw new Error("--merchant must not be empty");
        i++;
        break;
      case "--error-match":
        args.errorMatch = readValue(argv, i, token);
        i++;
        break;
      case "--limit": {
        const raw = readValue(argv, i, token);
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error("--limit must be a positive integer");
        }
        args.limit = limit;
        i++;
        break;
      }
      case "--all":
        args.all = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument "${token}"`);
    }
  }

  if (!args.command) throw new Error(USAGE);
  if (args.merchant && args.all) {
    throw new Error("Use either --merchant or --all, not both");
  }
  if ((args.command === "retry" || args.command === "purge") && !args.merchant && !args.all) {
    throw new Error(`${args.command} needs --merchant <id> or --all`);
  }
  return args;
}

function toFilter(args: ManageDlqArgs): WebhookDlqFilter {
  return {
    merchantId: args.merchant,
    errorMatch: args.errorMatch,
    limit: args.limit,
  };
}

/** Ask a yes/no question on the terminal. Defaults to "no". */
export async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Run one DLQ command. Returns the process exit code. Pure apart from the
 * injected queue, confirm and output hooks, so it can be unit tested.
 */
export async function runManageDlq(
  argv: string[],
  deps: ManageDlqDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  let args: ManageDlqArgs;
  try {
    args = parseManageDlqArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const filter = toFilter(args);

  if (args.command === "list") {
    const matched = await listWebhookDlq(filter, deps.queue);
    const summary = summarizeWebhookDlq(matched.map((m) => m.entry));
    out(`Failed webhooks: ${summary.totalFailed}`);
    for (const merchant of summary.merchants) {
      out(`merchant ${merchant.merchantId}: ${merchant.count} failed`);
      for (const error of merchant.errors) {
        out(`  ${error.count}x ${error.reason}`);
      }
    }
    return 0;
  }

  if (args.command === "retry") {
    const result = await replayWebhookDlq({ ...filter, dryRun: args.dryRun }, deps.queue);
    if (result.dryRun) {
      out(`Dry run: ${result.matched} failed webhook(s) would be re-queued`);
      return 0;
    }
    out(`Re-queued ${result.retried} of ${result.matched} failed webhook(s)`);
    for (const failure of result.errors) {
      err(`job ${failure.jobId}: ${failure.message}`);
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  // purge
  const preview = await listWebhookDlq(filter, deps.queue);
  if (args.dryRun) {
    out(`Dry run: ${preview.length} failed webhook(s) would be deleted`);
    return 0;
  }
  if (preview.length === 0) {
    out("No failed webhooks matched; nothing to purge");
    return 0;
  }
  if (!args.yes) {
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      err("purge needs confirmation: rerun with --yes in a non-interactive shell");
      return 1;
    }
    const confirmed = await (deps.confirm ?? promptYesNo)(
      `Permanently delete ${preview.length} failed webhook job(s)? [y/N] `,
    );
    if (!confirmed) {
      out("Purge cancelled");
      return 0;
    }
  }

  const result = await purgeWebhookDlq(filter, deps.queue);
  out(`Deleted ${result.removed} of ${result.matched} failed webhook(s)`);
  for (const failure of result.errors) {
    err(`job ${failure.jobId}: ${failure.message}`);
  }
  return result.errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  runManageDlq(process.argv.slice(2))
    .then(async (code) => {
      const { getDefaultWebhookDlqQueue } = await import("../queue/webhookDlqService.js");
      try {
        const queue = (await getDefaultWebhookDlqQueue()) as unknown as { close?: () => Promise<void> };
        await queue.close?.();
      } finally {
        process.exit(code);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
