import { Client } from "minio";

export type MinioArtifactRef = {
  storage: "minio";
  bucket: string;
  objectKey: string;
  etag: string | null;
};

const endpoint = process.env.MINIO_ENDPOINT?.trim() || "localhost";
const port = Number(process.env.MINIO_PORT?.trim() || "9000");
const useSSL = (process.env.MINIO_USE_SSL?.trim() || "false") === "true";
const accessKey = process.env.MINIO_ACCESS_KEY?.trim() || "minioadmin";
const secretKey = process.env.MINIO_SECRET_KEY?.trim() || "minioadmin";
const bucket = process.env.MINIO_BUCKET?.trim() || "restate-artifacts";

const client = new Client({
  endPoint: endpoint,
  port,
  useSSL,
  accessKey,
  secretKey,
});

let ensuredBucket = false;

const ensureBucket = async (): Promise<void> => {
  if (ensuredBucket) {
    return;
  }

  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, "us-east-1");
  }

  ensuredBucket = true;
};

const streamToString = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
};

export const writeArtifact = async (
  objectKeyPrefix: string,
  value: unknown,
): Promise<MinioArtifactRef> => {
  await ensureBucket();

  const objectKey = `${objectKeyPrefix}/${new Date().toISOString()}-${crypto.randomUUID()}.json`;
  const payload = JSON.stringify(value);

  const etag = await client.putObject(bucket, objectKey, payload, {
    "Content-Type": "application/json",
  });

  return {
    storage: "minio",
    bucket,
    objectKey,
    etag,
  };
};

export const readArtifact = async (ref: MinioArtifactRef): Promise<unknown> => {
  const stream = await client.getObject(ref.bucket, ref.objectKey);
  const body = await streamToString(stream);
  return JSON.parse(body);
};
