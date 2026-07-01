import { QueueOptions } from "bullmq";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const url = new URL(redisUrl);

export const connection = {
  host: url.hostname,
  port: parseInt(url.port || "6379", 10),
  username: url.username || undefined,
  password: url.password || undefined,
  tls: url.protocol === "rediss:" ? {} : undefined,
  maxRetriesPerRequest: null,
};

export const queueOptions: QueueOptions = {
  connection,
};
