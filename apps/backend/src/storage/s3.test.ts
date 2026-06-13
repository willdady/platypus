import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface S3ClientConfig {
  region?: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle?: boolean;
}

interface MockCommand {
  _type: string;
  input: Record<string, unknown>;
}

const sendMock = vi.fn();
let capturedConfigs: S3ClientConfig[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = sendMock;
    constructor(config: S3ClientConfig) {
      capturedConfigs.push(config);
    }
  }
  class MockPutObjectCommand implements MockCommand {
    _type = "PutObjectCommand";
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockGetObjectCommand implements MockCommand {
    _type = "GetObjectCommand";
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class MockDeleteObjectCommand implements MockCommand {
    _type = "DeleteObjectCommand";
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
  };
});

import { S3Storage } from "./s3.ts";

describe("S3Storage", () => {
  beforeEach(() => {
    process.env.STORAGE_S3_BUCKET = "test-bucket";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "test-key";
    process.env.STORAGE_S3_SECRET_ACCESS_KEY = "test-secret";
    sendMock.mockReset();
    capturedConfigs = [];
  });

  afterEach(() => {
    delete process.env.STORAGE_S3_BUCKET;
    delete process.env.STORAGE_S3_REGION;
    delete process.env.STORAGE_S3_ENDPOINT;
    delete process.env.STORAGE_S3_ACCESS_KEY_ID;
    delete process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  });

  describe("constructor", () => {
    it("should throw if STORAGE_S3_BUCKET is not set", () => {
      delete process.env.STORAGE_S3_BUCKET;
      expect(() => new S3Storage()).toThrow(
        "STORAGE_S3_BUCKET environment variable is required",
      );
    });

    it("should throw if credentials are not set", () => {
      delete process.env.STORAGE_S3_ACCESS_KEY_ID;
      delete process.env.STORAGE_S3_SECRET_ACCESS_KEY;
      expect(() => new S3Storage()).toThrow(
        "STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY are required",
      );
    });

    it("should create S3Client with configured region", () => {
      process.env.STORAGE_S3_REGION = "eu-west-1";
      new S3Storage();
      expect(capturedConfigs[0]).toEqual(
        expect.objectContaining({ region: "eu-west-1" }),
      );
    });

    it("should default region to us-east-1", () => {
      new S3Storage();
      expect(capturedConfigs[0]).toEqual(
        expect.objectContaining({ region: "us-east-1" }),
      );
    });

    it("should pass custom endpoint if set", () => {
      process.env.STORAGE_S3_ENDPOINT = "https://minio.local:9000";
      new S3Storage();
      expect(capturedConfigs[0]).toEqual(
        expect.objectContaining({
          endpoint: "https://minio.local:9000",
        }),
      );
    });
  });

  describe("put", () => {
    it("should send PutObjectCommand with correct parameters", async () => {
      sendMock.mockResolvedValueOnce({});
      const storage = new S3Storage();
      const data = Buffer.from("test content");

      await storage.put("org/ws/chat/msg/0-abc.png", data, "image/png");

      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0] as MockCommand;
      expect(cmd._type).toBe("PutObjectCommand");
      expect(cmd.input).toEqual({
        Bucket: "test-bucket",
        Key: "org/ws/chat/msg/0-abc.png",
        Body: data,
        ContentType: "image/png",
        Metadata: { "content-type": "image/png" },
      });
    });
  });

  describe("get", () => {
    it("should return file data and content type", async () => {
      const bodyData = Buffer.from("file content");
      sendMock.mockResolvedValueOnce({
        Body: (function* () {
          yield bodyData;
        })(),
        ContentType: "image/png",
      });

      const storage = new S3Storage();
      const result = await storage.get("org/ws/chat/msg/0-abc.png");

      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0] as MockCommand;
      expect(cmd._type).toBe("GetObjectCommand");
      expect(cmd.input).toEqual({
        Bucket: "test-bucket",
        Key: "org/ws/chat/msg/0-abc.png",
      });
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(bodyData);
      expect(result!.contentType).toBe("image/png");
    });

    it("should return null when Body is empty", async () => {
      sendMock.mockResolvedValueOnce({ Body: null });

      const storage = new S3Storage();
      const result = await storage.get("missing-body");

      expect(result).toBeNull();
    });

    it("should return null for NoSuchKey error", async () => {
      const error = new Error("NoSuchKey");
      error.name = "NoSuchKey";
      sendMock.mockRejectedValueOnce(error);

      const storage = new S3Storage();
      const result = await storage.get("non-existent");

      expect(result).toBeNull();
    });

    it("should return null for NoSuchKey error via Code property", async () => {
      const error = Object.assign(new Error("Not found"), {
        Code: "NoSuchKey",
      });
      sendMock.mockRejectedValueOnce(error);

      const storage = new S3Storage();
      const result = await storage.get("non-existent");

      expect(result).toBeNull();
    });

    it("should rethrow non-NoSuchKey errors", async () => {
      sendMock.mockRejectedValueOnce(new Error("Network error"));

      const storage = new S3Storage();
      await expect(storage.get("key")).rejects.toThrow("Network error");
    });

    it("should fallback to metadata content-type when ContentType is absent", async () => {
      const bodyData = Buffer.from("data");
      sendMock.mockResolvedValueOnce({
        Body: (function* () {
          yield bodyData;
        })(),
        ContentType: undefined,
        Metadata: { "content-type": "application/pdf" },
      });

      const storage = new S3Storage();
      const result = await storage.get("key");

      expect(result!.contentType).toBe("application/pdf");
    });

    it("should fallback to application/octet-stream when no content type available", async () => {
      const bodyData = Buffer.from("data");
      sendMock.mockResolvedValueOnce({
        Body: (function* () {
          yield bodyData;
        })(),
        ContentType: undefined,
        Metadata: {},
      });

      const storage = new S3Storage();
      const result = await storage.get("key");

      expect(result!.contentType).toBe("application/octet-stream");
    });
  });

  describe("delete", () => {
    it("should send DeleteObjectCommand with correct parameters", async () => {
      sendMock.mockResolvedValueOnce({});
      const storage = new S3Storage();

      await storage.delete("org/ws/chat/msg/0-abc.png");

      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0] as MockCommand;
      expect(cmd._type).toBe("DeleteObjectCommand");
      expect(cmd.input).toEqual({
        Bucket: "test-bucket",
        Key: "org/ws/chat/msg/0-abc.png",
      });
    });
  });
});
