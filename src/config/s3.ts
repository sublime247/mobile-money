import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

/**
 * S3 Configuration for KYC document storage
 */
export const s3Config = {
  region: process.env.AWS_REGION || "us-east-1",
  bucket: process.env.AWS_S3_BUCKET || "",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
};

/**
 * Create S3 client instance
 */
export const createS3Client = (): S3Client => {
  if (!s3Config.accessKeyId || !s3Config.secretAccessKey) {
    throw new Error(
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env",
    );
  }

  if (!s3Config.bucket) {
    throw new Error("S3 bucket not configured. Set AWS_S3_BUCKET in .env");
  }

  return new S3Client({
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
  });
};

/**
 * Get S3 client singleton
 */
let s3ClientInstance: S3Client | null = null;

export const getS3Client = (): S3Client => {
  if (!s3ClientInstance) {
    s3ClientInstance = createS3Client();
  }
  return s3ClientInstance;
};

/**
 * Generate S3 object URL
 */
export const getS3ObjectUrl = (key: string): string => {
  return `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${key}`;
};
