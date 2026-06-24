import { Command } from "commander";
import {
  getDashboardStats,
  getSystemHealth,
  getQueueMetrics,
  DashboardStats,
} from "../api";
import {
  printDashboard,
  printStatusLine,
  printError,
  printLoading,
  DashboardData,
  printSuccess,
} from "../dashboard";

interface DashboardOptions {
  watch?: boolean;
  interval?: number;
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .alias("db")
    .description("Show beautiful console dashboard with system metrics")
    .option(
      "-w, --watch",
      "Watch mode: refresh dashboard every interval",
      false,
    )
    .option(
      "-i, --interval <ms>",
      "Refresh interval in milliseconds (default: 5000)",
      "5000",
    )
    .action(async (opts: DashboardOptions) => {
      const interval = Math.max(1000, parseInt(opts.interval || "5000"));

      try {
        // First load: show loading spinner
        const stopLoading = printLoading("Fetching system metrics");

        let data = await fetchDashboardData();
        stopLoading();

        // Display initial dashboard
        printDashboard(data);
        printSuccess("Dashboard loaded successfully");

        // Watch mode: continuously refresh
        if (opts.watch) {
          console.log(`Watching for updates every ${interval}ms. Press Ctrl+C to exit.\n`);

          const refreshInterval = setInterval(async () => {
            try {
              data = await fetchDashboardData();
              console.clear();
              printDashboard(data);
              console.log(
                `ℹ Auto-refreshed at ${new Date().toLocaleTimeString()}`,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`Failed to refresh: ${msg}`);
            }
          }, interval);

          // Handle graceful shutdown
          process.on("SIGINT", () => {
            clearInterval(refreshInterval);
            printSuccess("Dashboard closed");
            process.exit(0);
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError("Failed to load dashboard", err as Error);
        process.exit(1);
      }
    });

  // Subcommand: live monitoring with status line
  program
    .command("dashboard:live")
    .description("Live status monitoring (compact view)")
    .option(
      "-i, --interval <ms>",
      "Refresh interval in milliseconds (default: 2000)",
      "2000",
    )
    .action(async (opts: DashboardOptions) => {
      const interval = Math.max(1000, parseInt(opts.interval || "2000"));

      try {
        const stopLoading = printLoading("Starting live monitor");
        stopLoading();
        console.log("Live monitoring active. Press Ctrl+C to exit.\n");

        const refreshInterval = setInterval(async () => {
          try {
            const data = await fetchDashboardData();
            printStatusLine(data);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Monitor error: ${msg}`);
          }
        }, interval);

        // Initial load
        const data = await fetchDashboardData();
        printStatusLine(data);

        process.on("SIGINT", () => {
          clearInterval(refreshInterval);
          console.log("\nLive monitor closed");
          process.exit(0);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError("Failed to start live monitor", err as Error);
        process.exit(1);
      }
    });

  // Subcommand: export metrics as JSON
  program
    .command("dashboard:export")
    .description("Export current metrics as JSON")
    .action(async () => {
      try {
        const data = await fetchDashboardData();
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError("Failed to export metrics", err as Error);
        process.exit(1);
      }
    });
}

/**
 * Fetch dashboard data from API with fallback and aggregation
 */
async function fetchDashboardData(): Promise<DashboardData> {
  // Try primary endpoint first, fall back to individual calls
  try {
    const stats = await getDashboardStats();
    return stats as DashboardData;
  } catch (err) {
    // Fallback: fetch individual components
    console.warn("Falling back to individual API calls...");
    return await fetchDashboardDataFallback();
  }
}

/**
 * Fallback implementation: aggregate data from individual endpoints
 */
async function fetchDashboardDataFallback(): Promise<DashboardData> {
  const [health, queue, stats] = await Promise.all([
    getSystemHealth().catch(() => ({
      database: "unhealthy" as const,
      redis: "unhealthy" as const,
      stellar: "unhealthy" as const,
      responseTime: undefined,
    })),
    getQueueMetrics().catch(() => ({
      totalJobs: 0,
      pendingJobs: 0,
      activeJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      dlqSize: 0,
    })),
    getDashboardStats().catch(() => ({})),
  ]);

  return {
    health,
    queue,
    transactions: (stats as DashboardStats)?.transactions,
    providers: (stats as DashboardStats)?.providers,
  };
}
