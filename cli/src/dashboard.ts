import chalk from "chalk";
import Table from "cli-table3";
import figlet from "figlet";

export interface SystemHealth {
  database: "healthy" | "degraded" | "unhealthy";
  redis: "healthy" | "degraded" | "unhealthy";
  stellar: "healthy" | "degraded" | "unhealthy";
  responseTime?: number;
}

export interface QueueStats {
  totalJobs: number;
  pendingJobs: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  dlqSize: number;
}

export interface DashboardData {
  health: SystemHealth;
  queue: QueueStats;
  transactions?: {
    totalCount: number;
    successRate: number;
    totalVolume: number;
    activeUsers: number;
  };
  providers?: {
    [key: string]: {
      status: "online" | "offline" | "degraded";
      failureRate: number;
      lastChecked: string;
    };
  };
}

/**
 * Print ASCII banner
 */
export function printBanner(): void {
  try {
    const banner = figlet.textSync("MOMO CLI", {
      horizontalLayout: "default",
      verticalLayout: "default",
    });
    console.log(chalk.cyan(banner));
  } catch (err) {
    // Fallback if figlet fails
    console.log(chalk.cyan("╔═══════════════════════════════════════╗"));
    console.log(chalk.cyan("║         MOMO CLI DASHBOARD            ║"));
    console.log(chalk.cyan("╚═══════════════════════════════════════╝"));
  }
  console.log(chalk.gray("Mobile Money ↔ Stellar Bridge | Admin Dashboard\n"));
}

/**
 * Get health status icon and color
 */
function getHealthIcon(status: "healthy" | "degraded" | "unhealthy"): string {
  switch (status) {
    case "healthy":
      return chalk.green("✓ HEALTHY");
    case "degraded":
      return chalk.yellow("⚠ DEGRADED");
    case "unhealthy":
      return chalk.red("✗ UNHEALTHY");
  }
}

/**
 * Print system health status
 */
export function printHealthStatus(health: SystemHealth): void {
  console.log(chalk.bold("\n📊 SYSTEM HEALTH STATUS\n"));

  const healthTable = new Table({
    head: [
      chalk.bold.cyan("Component"),
      chalk.bold.cyan("Status"),
      chalk.bold.cyan("Response Time"),
    ],
    style: {
      head: [],
      border: ["cyan"],
      compact: false,
    },
  });

  healthTable.push(
    ["Database", getHealthIcon(health.database), `${health.responseTime || "N/A"}ms`],
    ["Redis Cache", getHealthIcon(health.redis), `${health.responseTime || "N/A"}ms`],
    ["Stellar Network", getHealthIcon(health.stellar), `${health.responseTime || "N/A"}ms`],
  );

  console.log(healthTable.toString());
}

/**
 * Print queue statistics
 */
export function printQueueStats(queue: QueueStats): void {
  console.log(chalk.bold("\n📦 QUEUE STATISTICS\n"));

  const queueTable = new Table({
    head: [chalk.bold.cyan("Metric"), chalk.bold.cyan("Count")],
    style: {
      head: [],
      border: ["cyan"],
      compact: false,
    },
  });

  const total = queue.totalJobs;
  const pendingPercent = total > 0 ? ((queue.pendingJobs / total) * 100).toFixed(1) : "0";
  const activePercent = total > 0 ? ((queue.activeJobs / total) * 100).toFixed(1) : "0";
  const failedPercent = total > 0 ? ((queue.failedJobs / total) * 100).toFixed(1) : "0";

  queueTable.push(
    ["Total Jobs", chalk.bold.white(total.toString())],
    [
      "Pending",
      `${chalk.yellow(queue.pendingJobs.toString())} (${pendingPercent}%)`,
    ],
    [
      "Active",
      `${chalk.blue(queue.activeJobs.toString())} (${activePercent}%)`,
    ],
    [
      "Completed",
      chalk.green(queue.completedJobs.toString()),
    ],
    [
      "Failed",
      `${chalk.red(queue.failedJobs.toString())} (${failedPercent}%)`,
    ],
    [
      "Dead Letter Queue",
      queue.dlqSize > 0 ? chalk.red.bold(queue.dlqSize.toString()) : chalk.gray("Empty"),
    ],
  );

  console.log(queueTable.toString());
}

/**
 * Print transaction statistics
 */
export function printTransactionStats(
  transactions: DashboardData["transactions"],
): void {
  if (!transactions) return;

  console.log(chalk.bold("\n💳 TRANSACTION STATISTICS\n"));

  const txTable = new Table({
    head: [chalk.bold.cyan("Metric"), chalk.bold.cyan("Value")],
    style: {
      head: [],
      border: ["cyan"],
      compact: false,
    },
  });

  const successColor = transactions.successRate >= 95 ? chalk.green : transactions.successRate >= 80 ? chalk.yellow : chalk.red;

  txTable.push(
    ["Total Transactions", chalk.bold.white(transactions.totalCount.toString())],
    ["Success Rate", `${successColor(transactions.successRate.toFixed(2))}%`],
    ["Total Volume", chalk.cyan(`${transactions.totalVolume.toLocaleString()} XAF`)],
    ["Active Users", chalk.magenta(transactions.activeUsers.toString())],
  );

  console.log(txTable.toString());
}

/**
 * Print provider status
 */
export function printProviderStatus(
  providers: DashboardData["providers"],
): void {
  if (!providers || Object.keys(providers).length === 0) return;

  console.log(chalk.bold("\n🌍 PROVIDER STATUS\n"));

  const providerTable = new Table({
    head: [
      chalk.bold.cyan("Provider"),
      chalk.bold.cyan("Status"),
      chalk.bold.cyan("Failure Rate"),
      chalk.bold.cyan("Last Checked"),
    ],
    style: {
      head: [],
      border: ["cyan"],
      compact: false,
    },
  });

  Object.entries(providers).forEach(([provider, info]) => {
    let statusStr: string;
    switch (info.status) {
      case "online":
        statusStr = chalk.green("🟢 Online");
        break;
      case "offline":
        statusStr = chalk.red("🔴 Offline");
        break;
      case "degraded":
        statusStr = chalk.yellow("🟡 Degraded");
        break;
    }

    const failureColor = info.failureRate > 10 ? chalk.red : info.failureRate > 5 ? chalk.yellow : chalk.green;

    providerTable.push([
      chalk.bold(provider),
      statusStr,
      `${failureColor(info.failureRate.toFixed(2))}%`,
      chalk.gray(new Date(info.lastChecked).toLocaleTimeString()),
    ]);
  });

  console.log(providerTable.toString());
}

/**
 * Print complete dashboard
 */
export function printDashboard(data: DashboardData): void {
  console.clear();
  printBanner();
  printHealthStatus(data.health);
  printQueueStats(data.queue);
  if (data.transactions) {
    printTransactionStats(data.transactions);
  }
  if (data.providers) {
    printProviderStatus(data.providers);
  }
  console.log();
}

/**
 * Print a compact status line
 */
export function printStatusLine(data: DashboardData): void {
  const health = [data.health.database, data.health.redis, data.health.stellar];
  const allHealthy = health.every((s) => s === "healthy");
  const healthStr = allHealthy
    ? chalk.green("✓ All Systems Healthy")
    : chalk.yellow("⚠ Some Systems Degraded");

  const queueStr =
    data.queue.dlqSize > 0
      ? chalk.red(`DLQ: ${data.queue.dlqSize} | `)
      : "";

  console.log(
    `${healthStr} | Queue: ${chalk.cyan(
      data.queue.totalJobs.toString(),
    )} | ${queueStr}Updated: ${new Date().toLocaleTimeString()}`,
  );
}

/**
 * Print loading spinner frame
 */
export function printLoading(message: string = "Loading"): void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;

  const interval = setInterval(() => {
    process.stdout.write(
      `\r${chalk.cyan(frames[frameIndex])} ${message}...`,
    );
    frameIndex = (frameIndex + 1) % frames.length;
  }, 80);

  return () => {
    clearInterval(interval);
    process.stdout.write("\r");
  };
}

/**
 * Print error message with formatting
 */
export function printError(message: string, error?: Error): void {
  console.log(chalk.red(`\n✗ Error: ${message}`));
  if (error) {
    console.log(chalk.gray(`Details: ${error.message}`));
  }
  console.log();
}

/**
 * Print success message
 */
export function printSuccess(message: string): void {
  console.log(chalk.green(`\n✓ ${message}\n`));
}

/**
 * Print info message
 */
export function printInfo(message: string): void {
  console.log(chalk.cyan(`ℹ ${message}\n`));
}
