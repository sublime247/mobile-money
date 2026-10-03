import { pool } from "../config/database";
import logger from "../utils/logger";
import { deadLetterQueue, DLQ_NAME } from "../queue/dlq";
import { replayDeadLetterJob, FailedJobRecord } from "../config/queue";
import { dlqTotal, dlqReplayed } from "../utils/metrics";

export interface DlqMonitorConfig {
  checkIntervalMs?: number;
  alertThreshold?: number;
  queueName?: string;
  slackWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface ReplayOptions {
  queueName?: string;
  errorCodes?: string[];
  jobIds?: string[];
  limit?: number;
  dryRun?: boolean;
}

export interface ReplayedJobSummary {
  id: string;
  queueName: string;
  errorMessage: string;
  status: "replayed" | "failed" | "matched";
  replayedJobId?: string;
  error?: string;
}

export interface ReplayResult {
  success: boolean;
  totalMatched: number;
  replayedCount: number;
  skippedCount: number;
  failedCount: number;
  dryRun: boolean;
  jobs: ReplayedJobSummary[];
}

export interface DlqDepthStatus {
  queueName: string;
  depth: number;
  threshold: number;
  alerted: boolean;
  timestamp: string;
}

export interface DlqAlertRecord {
  id: string;
  queueName: string;
  depth: number;
  threshold: number;
  message: string;
  timestamp: string;
  delivered: boolean;
}

export class DlqMonitorService {
  private config: Required<DlqMonitorConfig>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private alertHistory: DlqAlertRecord[] = [];

  constructor(config?: DlqMonitorConfig) {
    this.config = {
      checkIntervalMs:
        config?.checkIntervalMs ||
        parseInt(process.env.DLQ_MONITOR_INTERVAL_MS || "60000", 10),
      alertThreshold:
        config?.alertThreshold ||
        parseInt(process.env.DLQ_ALERT_THRESHOLD || "10", 10),
      queueName: config?.queueName || DLQ_NAME,
      slackWebhookUrl:
        config?.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL || "",
      telegramBotToken:
        config?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
      telegramChatId:
        config?.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
    };
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getConfig(): Required<DlqMonitorConfig> {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<DlqMonitorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public getAlertHistory(): DlqAlertRecord[] {
    return [...this.alertHistory];
  }

  public clearAlertHistory(): void {
    this.alertHistory = [];
  }

  /**
   * Starts background worker monitoring DLQ depth at configured intervals.
   */
  public start(intervalMs?: number): void {
    if (this.running) {
      return;
    }

    if (intervalMs) {
      this.config.checkIntervalMs = intervalMs;
    }

    this.running = true;
    logger.info(
      `[DLQ Monitor] Started worker. Polling queue '${this.config.queueName}' every ${this.config.checkIntervalMs}ms with alert threshold ${this.config.alertThreshold}.`,
    );

    this.timer = setInterval(async () => {
      try {
        await this.checkDlqDepth();
      } catch (err) {
        logger.error("[DLQ Monitor] Scheduled check failed:", err);
      }
    }, this.config.checkIntervalMs);
  }

  /**
   * Stops background monitoring worker.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info("[DLQ Monitor] Stopped worker.");
  }

  /**
   * Checks current DLQ depth, updates Prometheus metrics, and triggers alert if depth exceeds threshold.
   */
  public async checkDlqDepth(queueNameOverride?: string): Promise<DlqDepthStatus> {
    const queueName = queueNameOverride || this.config.queueName;
    let depth = 0;

    try {
      if (pool && typeof pool.query === "function") {
        const queryText =
          queueName === DLQ_NAME
            ? `SELECT COUNT(*)::int AS count FROM failed_jobs WHERE status = 'failed';`
            : `SELECT COUNT(*)::int AS count FROM failed_jobs WHERE status = 'failed' AND queue_name = $1;`;
        const queryParams = queueName === DLQ_NAME ? [] : [queueName];
        const res = await pool.query(queryText, queryParams);
        depth = Number(res.rows?.[0]?.count ?? 0);
      }
    } catch (dbErr) {
      logger.warn("[DLQ Monitor] DB query for failed_jobs failed, checking BullMQ:", dbErr);
    }

    // Also check BullMQ queue if available or if db count was 0
    if (depth === 0 && deadLetterQueue && typeof deadLetterQueue.getWaitingCount === "function") {
      try {
        const waitingCount = await deadLetterQueue.getWaitingCount();
        if (waitingCount > depth) {
          depth = waitingCount;
        }
      } catch (bullErr) {
        logger.debug("[DLQ Monitor] BullMQ depth query skipped or unavailable:", bullErr);
      }
    }

    // Update Prometheus metric
    dlqTotal.labels(queueName).set(depth);

    let alerted = false;
    if (depth >= this.config.alertThreshold) {
      alerted = await this.triggerAlert(queueName, depth, this.config.alertThreshold);
    }

    return {
      queueName,
      depth,
      threshold: this.config.alertThreshold,
      alerted,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Dispatches alerts to Telegram/Slack webhooks and logger when depth exceeds threshold.
   */
  private async triggerAlert(
    queueName: string,
    depth: number,
    threshold: number,
  ): Promise<boolean> {
    const message = `[DLQ ALERT] Queue '${queueName}' has ${depth} failed jobs, exceeding alert threshold of ${threshold}!`;
    logger.warn(message, { queueName, depth, threshold });

    let delivered = false;

    // Slack Webhook Alert
    if (this.config.slackWebhookUrl) {
      try {
        const response = await fetch(this.config.slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: message,
            attachments: [
              {
                color: "danger",
                fields: [
                  { title: "Queue", value: queueName, short: true },
                  { title: "Failed Depth", value: String(depth), short: true },
                  { title: "Threshold", value: String(threshold), short: true },
                ],
                ts: Math.floor(Date.now() / 1000),
              },
            ],
          }),
        });
        if (response.ok) {
          delivered = true;
          logger.info(`[DLQ Monitor] Alert sent successfully to Slack.`);
        }
      } catch (slackErr) {
        logger.error("[DLQ Monitor] Failed to send Slack alert:", slackErr);
      }
    }

    // Telegram Bot Alert
    if (this.config.telegramBotToken && this.config.telegramChatId) {
      try {
        const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.config.telegramChatId,
            text: `⚠️ *Mobile Money DLQ Alert*\n\n${message}`,
            parse_mode: "Markdown",
          }),
        });
        if (response.ok) {
          delivered = true;
          logger.info(`[DLQ Monitor] Alert sent successfully to Telegram.`);
        }
      } catch (tgErr) {
        logger.error("[DLQ Monitor] Failed to send Telegram alert:", tgErr);
      }
    }

    const alertRecord: DlqAlertRecord = {
      id: `DLQ-ALERT-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      queueName,
      depth,
      threshold,
      message,
      timestamp: new Date().toISOString(),
      delivered,
    };
    this.alertHistory.push(alertRecord);

    return true;
  }

  /**
   * Safely replays failed jobs with filtered error codes.
   */
  public async replayFailedJobs(options: ReplayOptions = {}): Promise<ReplayResult> {
    const limit = Math.min(options.limit || 50, 1000);
    const dryRun = Boolean(options.dryRun);

    const conditions: string[] = ["status = 'failed'"];
    const params: any[] = [];
    let paramIndex = 1;

    if (options.queueName) {
      conditions.push(`queue_name = $${paramIndex}`);
      params.push(options.queueName);
      paramIndex++;
    }

    if (options.jobIds && options.jobIds.length > 0) {
      conditions.push(`id = ANY($${paramIndex})`);
      params.push(options.jobIds);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const selectQuery = `
      SELECT * FROM failed_jobs
      ${whereClause}
      ORDER BY failed_at ASC
      LIMIT $${paramIndex};
    `;
    params.push(limit);

    let rows: FailedJobRecord[] = [];
    try {
      const res = await pool.query(selectQuery, params);
      rows = res.rows || [];
    } catch (err) {
      logger.error("[DLQ Monitor] Failed to fetch jobs for replay:", err);
      throw new Error(`Failed to query dead-letter jobs: ${(err as Error).message}`);
    }

    // Filter by error codes if specified
    const filteredRows = options.errorCodes && options.errorCodes.length > 0
      ? rows.filter((row) => {
          const errMsg = (row.error_message || "").toUpperCase();
          return options.errorCodes!.some((code) =>
            errMsg.includes(code.toUpperCase().trim()),
          );
        })
      : rows;

    const jobsSummary: ReplayedJobSummary[] = [];
    let replayedCount = 0;
    let failedCount = 0;

    for (const job of filteredRows) {
      if (dryRun) {
        jobsSummary.push({
          id: job.id,
          queueName: job.queue_name,
          errorMessage: job.error_message,
          status: "matched",
        });
        continue;
      }

      try {
        const replayRes = await replayDeadLetterJob(job.id);
        dlqReplayed.labels(job.queue_name, "success").inc();
        replayedCount++;
        jobsSummary.push({
          id: job.id,
          queueName: job.queue_name,
          errorMessage: job.error_message,
          status: "replayed",
          replayedJobId: replayRes.job?.replayedJobId,
        });
      } catch (replayErr) {
        dlqReplayed.labels(job.queue_name, "failed").inc();
        failedCount++;
        jobsSummary.push({
          id: job.id,
          queueName: job.queue_name,
          errorMessage: job.error_message,
          status: "failed",
          error: (replayErr as Error).message,
        });
      }
    }

    // Refresh gauge metric after replay
    await this.checkDlqDepth(options.queueName).catch(() => undefined);

    return {
      success: true,
      totalMatched: filteredRows.length,
      replayedCount,
      skippedCount: dryRun ? filteredRows.length : 0,
      failedCount,
      dryRun,
      jobs: jobsSummary,
    };
  }
}

export const dlqMonitorService = new DlqMonitorService();
