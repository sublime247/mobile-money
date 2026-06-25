import axios, { AxiosInstance } from "axios";
import { getConfig } from "./config";

export interface Transaction {
  id: string;
  referenceNumber: string;
  type: string;
  amount: string;
  phoneNumber: string;
  provider: string;
  status: string;
  retryCount: number;
  createdAt: string;
}

function buildClient(): AxiosInstance {
  const { apiUrl, apiKey } = getConfig();
  return axios.create({
    baseURL: apiUrl,
    headers: { "X-API-Key": apiKey },
  });
}

function extractMessage(err: any): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as Record<string, unknown> | undefined;
    if (data) {
      if (typeof data["error"] === "string") return data["error"];
      if (typeof data["message"] === "string") return data["message"];
    }
    if (err.message) return err.message;
    if (err.code) return `Connection failed: ${err.code}`;
  }
  if (err instanceof Error) {
    if (err.message) return err.message;
    if (err.cause && Array.isArray((err.cause as any).errors)) {
      return (err.cause as any).errors.map((e: any) => e.message).join(", ");
    }
    const anyErr = err as any;
    if (anyErr.code) return `Error: ${anyErr.code}`;
  }
  return String(err);
}

export async function getTransaction(id: string): Promise<Transaction> {
  try {
    const { data } = await buildClient().get<Transaction>(
      `/api/admin/transactions/${id}`,
    );
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}

export async function retryTransaction(
  id: string,
): Promise<{ message: string; transaction: Transaction }> {
  try {
    const { data } = await buildClient().put<{
      message: string;
      transaction: Transaction;
    }>(`/api/admin/transactions/${id}`, { status: "pending" });
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}

export async function checkAuth(): Promise<{ status: string }> {
  try {
    const { data } = await buildClient().get<{ status: string }>("/api/stats");
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}

export interface HealthStatus {
  database: "healthy" | "degraded" | "unhealthy";
  redis: "healthy" | "degraded" | "unhealthy";
  stellar: "healthy" | "degraded" | "unhealthy";
  responseTime?: number;
}

export interface DashboardStats {
  health: HealthStatus;
  queue: {
    totalJobs: number;
    pendingJobs: number;
    activeJobs: number;
    completedJobs: number;
    failedJobs: number;
    dlqSize: number;
  };
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

export async function getDashboardStats(): Promise<DashboardStats> {
  try {
    const { data } = await buildClient().get<DashboardStats>(
      "/api/admin/dashboard/stats",
    );
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}

export async function getSystemHealth(): Promise<HealthStatus> {
  try {
    const { data } = await buildClient().get<HealthStatus>("/api/admin/health");
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}

export async function getQueueMetrics() {
  try {
    const { data } = await buildClient().get("/api/admin/queue/stats");
    return data;
  } catch (err) {
    throw new Error(extractMessage(err));
  }
}
