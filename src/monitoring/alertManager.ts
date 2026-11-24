import { notifySlackAlert } from "../services/loggers";

export interface CriticalAlert {
  source: string;
  message: string;
  error?: Error;
}

export async function reportCriticalAlert(alert: CriticalAlert): Promise<void> {
  await notifySlackAlert({
    statusCode: 500,
    method: "WORKER",
    path: `/${alert.source}`,
    timestamp: new Date().toISOString(),
    error: alert.error ?? new Error(alert.message),
  });
}
