import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

/**
 * S3 Configuration for KYC document storage.
 * Primary is used for writes/normal reads; replica is optional and only used
 * for read failover when the primary read path errors.
 */
export const s3Config = {
  region: process.env.AWS_REGION || "us-east-1",
  bucket: process.env.AWS_S3_BUCKET || "",
  replicaRegion:
    process.env.AWS_S3_REPLICA_REGION || process.env.AWS_REGION || "us-east-1",
  replicaBucket: process.env.AWS_S3_REPLICA_BUCKET || "",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
};

const hasS3Credentials = (): boolean =>
  Boolean(s3Config.accessKeyId && s3Config.secretAccessKey);

const createConfiguredS3Client = (region: string): S3Client => {
  if (!hasS3Credentials()) {
    throw new Error(
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env",
    );
  }
  return new S3Client({
    region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
  });
};

/**
 * Create primary S3 client instance
 */
export const createS3Client = (): S3Client => {
  if (!s3Config.bucket) {
    throw new Error("S3 bucket not configured. Set AWS_S3_BUCKET in .env");
  }
  return createConfiguredS3Client(s3Config.region);
};

let s3ClientInstance: S3Client | null = null;
let s3ReplicaClientInstance: S3Client | null = null;

export const getS3Client = (): S3Client => {
  if (!s3ClientInstance) {
    s3ClientInstance = createS3Client();
  }
  return s3ClientInstance;
};

export const getReplicaS3Client = (): S3Client | null => {
  if (!s3Config.replicaBucket) return null;
  if (!s3ReplicaClientInstance) {
    s3ReplicaClientInstance = createConfiguredS3Client(s3Config.replicaRegion);
  }
  return s3ReplicaClientInstance;
};

export const getS3BucketTargets = (): Array<{
  bucket: string;
  region: string;
  client: S3Client;
  isReplica: boolean;
}> => {
  const targets: Array<{
    bucket: string;
    region: string;
    client: S3Client;
    isReplica: boolean;
  }> = [{ bucket: s3Config.bucket, region: s3Config.region, client: getS3Client(), isReplica: false }];

  const replicaClient = getReplicaS3Client();
  if (replicaClient && s3Config.replicaBucket) {
    targets.push({
      bucket: s3Config.replicaBucket,
      region: s3Config.replicaRegion,
      client: replicaClient,
      isReplica: true,
    });
  }
  return targets;
};

/**
 * Generate S3 object URL
 */
export const getS3ObjectUrl = (
  key: string,
  bucket = s3Config.bucket,
  region = s3Config.region,
): string => {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

/**
 * Generate a presigned URL for reading an S3 object.
 * Falls back to replica bucket on primary outage/read failure.
 */
export const getSignedObjectUrl = async (
  key: string,
  expiresIn = 900,
): Promise<string> => {
  let lastError: unknown;
  for (const target of getS3BucketTargets()) {
    try {
      const command = new GetObjectCommand({ Bucket: target.bucket, Key: key });
      return await getSignedUrl(target.client, command, { expiresIn });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to sign S3 object URL");
};
