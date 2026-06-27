const useColor =
  process.stdout.isTTY === true &&
  process.stderr.isTTY === true &&
  process.env.NO_COLOR !== "1" &&
  process.env.CI !== "true";

const colors = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};

const icons = {
  error: "X",
  warning: "!",
  success: "+",
  info: "i",
};

export const CLI_ERROR_CODES = {
  MissingArgument: "CLI_MISSING_ARGUMENT",
  InvalidBatchId: "CLI_INVALID_BATCH_ID",
  ExecutionFailed: "CLI_EXECUTION_FAILED",
  UnknownCommand: "CLI_UNKNOWN_COMMAND",
} as const;

export type CliErrorCode =
  (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

function style(text: string, color: keyof typeof colors, bold = false): string {
  return `${bold ? colors.bold : ""}${colors[color]}${text}${colors.reset}`;
}

function formatLabel(level: "error" | "warning" | "success" | "info"): string {
  switch (level) {
    case "error":
      return style(`${icons.error} Error`, "red", true);
    case "warning":
      return style(`${icons.warning} Warning`, "yellow", true);
    case "success":
      return style(`${icons.success} Success`, "green", true);
    case "info":
      return style(`${icons.info} Info`, "cyan", true);
  }
}

function formatCode(code?: CliErrorCode): string {
  return code ? `${style(`[${code}]`, "gray", true)} ` : "";
}

export function formatCliHeading(title: string): string {
  return `${style(title, "cyan", true)}\n${style("=".repeat(title.length), "gray")}`;
}

export function printInfo(message: string): void {
  console.log(`${formatLabel("info")}: ${message}`);
}

export function printSuccess(message: string): void {
  console.log(`${formatLabel("success")}: ${message}`);
}

export function printWarning(message: string): void {
  console.warn(`${formatLabel("warning")}: ${message}`);
}

export function printError(
  message: string,
  error?: unknown,
  code?: CliErrorCode,
): void {
  const output = `${formatLabel("error")}: ${formatCode(code)}${message}`;
  console.error(output);

  if (error instanceof Error && error.message) {
    console.error(`${style("Details:", "gray", true)} ${error.message}`);
    if (error.cause instanceof Error && error.cause.message) {
      console.error(`${style("Cause:", "gray", true)} ${error.cause.message}`);
    }
    return;
  }

  if (error !== undefined && error !== null) {
    console.error(`${style("Details:", "gray", true)} ${String(error)}`);
  }
}

