import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";

export function discardUpload(options: {
  ddb: DynamoDBClient;
  s3: S3Client;
  table: string;
  email: string;
  sub?: string;
  reservation: Record<string, any>;
  duplicateOf?: string;
  // The scheduled worker reconciles the complete partition's reserved total.
  releaseQuota?: boolean;
}): Promise<boolean>;
