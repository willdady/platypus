import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import {
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTasksRequest,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  TaskPushNotificationConfig,
  TaskState,
  type SendMessageResult,
  type Task,
} from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

// The model is the only thing mocked. The SDK's own client drives the app, so
// a wire shape that drifts from what it sends or parses fails here.
const { model } = vi.hoisted(() => ({
  model: {
    deltas: ["Hello ", "from ", "Helper"],
    hold: null as Promise<void> | null,
    calls: 0,
  },
}));
vi.mock("../services/provider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/provider.ts")>()),
  openProvider: () => ({
    languageModel: () =>
      new MockLanguageModelV3({
        doStream: async () => {
          model.calls += 1;
          await model.hold;
          const chunks: LanguageModelV3StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            ...model.deltas.map((delta): LanguageModelV3StreamPart => ({
              type: "text-delta",
              id: "t1",
              delta,
            })),
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ];
          return { stream: convertArrayToReadableStream(chunks) };
        },
        doGenerate: () => Promise.reject(new Error("no titling in tests")),
      }),
    embeddingModel: () => {
      throw new Error("no embeddings in tests");
    },
  }),
}));

vi.mock("../services/notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import app from "../server.ts";
import {
  hashBearerToken,
  resetTokenTouches,
} from "../services/bearer-token.ts";
import { resetA2aRunSlots } from "../services/a2a-call.ts";
import { setA2aFallbackPollMs } from "../services/a2a-events.ts";
import { runRegistry } from "../runs/run-registry.ts";

const TOKEN = "pa2a_the-right-token";
/**
 * The endpoint's base URL, as a client is configured with it. The SDK
 * resolves the card path relative to it, so without the trailing slash it
 * would ask for `/a2a/.well-known/agent-card.json`.
 */
const BASE_URL = "http://localhost:4001/a2a/ep-1/";
const REPLY = "Hello from Helper";

/**
 * `fetch` for the SDK, answered by the app in-process: no network. It adds
 * the bearer token, as a client configured with one does.
 */
const appFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  const url = input instanceof Request ? input.url : String(input);
  return Promise.resolve(app.request(url, { ...init, headers }));
};

/** A client found from the endpoint's base URL, as a real one would be. */
const connect = ({ polling = false } = {}): Promise<Client> =>
  new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl: appFetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: appFetch }),
      clientConfig: { polling },
    }),
  ).createFromUrl(BASE_URL);

const LIVE = {
  tokenCreatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
};

const seed = () =>
  seedDb(
    {
      organization: [{ id: "org-1", name: "Acme", a2aGate: "all" }],
      workspace: [
        {
          id: "ws-1",
          organizationId: "org-1",
          ownerId: "owner-1",
          name: "Support",
          a2aAllowed: false,
        },
      ],
      organization_member: [
        {
          id: "m-1",
          organizationId: "org-1",
          userId: "owner-1",
          role: "member",
        },
      ],
      user: [{ id: "owner-1", name: "Olive Owner" }],
      provider: [
        {
          id: "p-1",
          workspaceId: "ws-1",
          organizationId: null,
          name: "Test",
          providerType: "OpenAI",
          apiKey: "sk-test",
          apiMode: "responses",
          searchSource: "native",
          modelIds: ["gpt-test"],
          taskModelId: "gpt-test",
          memoryExtractionModelId: "gpt-test",
        },
      ],
      agent: [
        {
          id: "agent-1",
          workspaceId: "ws-1",
          providerId: "p-1",
          modelId: "gpt-test",
          name: "Helper",
          description: "Internal",
        },
      ],
      a2a_endpoint: [
        {
          id: "ep-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          name: "Acme helpdesk",
          description: "Ask about your Acme order",
          enabled: true,
        },
      ],
      a2a_token: [
        {
          id: "tok-1",
          endpointId: "ep-1",
          name: "Telegram via Hermes",
          tokenHash: hashBearerToken(TOKEN),
          ...LIVE,
        } satisfies Row,
      ],
    },
    {
      unique: {
        chat: [{ name: "chat_pkey", columns: ["id"] }],
        a2a_task: [
          {
            name: "idx_a2a_task_chat_id_message_id",
            columns: ["chatId", "messageId"],
          },
        ],
      },
    },
  );

/** A SendMessage request, built from its wire JSON by the SDK. */
const message = (messageId: string) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text: "Where is my order?" }],
    },
  });

const asTask = (result: SendMessageResult): Task => {
  if (!("status" in result)) throw new Error("expected a Task, got a Message");
  return result;
};

const replyOf = (task: Task) => {
  const content = task.artifacts[0]?.parts[0]?.content;
  return content?.$case === "text" ? content.value : undefined;
};

const collect = async (events: AsyncIterable<StreamResponse>) => {
  const all: StreamResponse[] = [];
  for await (const event of events) all.push(event);
  return all;
};

/** A Task left running: its model call waits until `release()`. */
const startHeld = async (client: Client, messageId = "msg-a") => {
  let release = () => {};
  model.hold = new Promise((resolve) => (release = resolve));
  const task = asTask(await client.sendMessage(message(messageId)));
  await vi.waitFor(() => expect(model.calls).toBeGreaterThan(0));
  return { task, release };
};

describe("A2A endpoints through the @a2a-js/sdk client", () => {
  const push = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.hold = null;
    model.calls = 0;
    resetTokenTouches();
    resetA2aRunSlots();
    setA2aFallbackPollMs(50);
    // Push deliveries go to global fetch; the client never does.
    push.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", push);
    seed();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setA2aFallbackPollMs();
    const held = runRegistry.heldRuns().map(({ runId }) => runId);
    for (const runId of held) runRegistry.cancel(runId);
    await vi.waitFor(() =>
      expect(held.filter((runId) => runRegistry.has(runId))).toEqual([]),
    );
  });

  it("discovers the card from the endpoint's base URL", async () => {
    const client = await connect();

    // The card offers an extended card, so this is GetExtendedAgentCard.
    const card = await client.getAgentCard();

    expect(card.name).toBe("Acme helpdesk");
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: "http://localhost:4001/a2a/ep-1",
      protocolBinding: "JSONRPC",
    });
    expect(client.protocolVersion).toBe("1.0");
  });

  it("sends a blocking message and reads the Task back with GetTask", async () => {
    const client = await connect();

    const task = asTask(await client.sendMessage(message("msg-a")));

    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(replyOf(task)).toBe(REPLY);
    const got = await client.getTask(GetTaskRequest.fromJSON({ id: task.id }));
    expect(got).toMatchObject({ id: task.id, contextId: task.contextId });
    expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(replyOf(got)).toBe(REPLY);
  });

  it("sends a message that returns immediately, then polls it to its end", async () => {
    const client = await connect({ polling: true });
    const { task, release } = await startHeld(client);

    expect([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
    ]).toContain(task.status?.state);
    release();

    await vi.waitFor(async () => {
      const got = await client.getTask(
        GetTaskRequest.fromJSON({ id: task.id }),
      );
      expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    });
  });

  it("streams a message through the SDK's stream iterator", async () => {
    const client = await connect();

    const events = await collect(client.sendMessageStream(message("msg-a")));

    const [first] = events;
    expect(first.payload?.$case).toBe("task");
    const updates = events.flatMap((e) =>
      e.payload?.$case === "artifactUpdate" ? [e.payload.value] : [],
    );
    expect(updates.at(-1)?.artifact?.parts[0]?.content).toEqual({
      $case: "text",
      value: REPLY,
    });
    const last = events.at(-1)?.payload;
    expect(last?.$case).toBe("statusUpdate");
    if (last?.$case !== "statusUpdate") return;
    expect(last.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("subscribes to a running Task and follows it to its end", async () => {
    const client = await connect({ polling: true });
    const { task, release } = await startHeld(client);

    const stream = client.resubscribeTask(
      SubscribeToTaskRequest.fromJSON({ id: task.id }),
    );
    const first = await stream.next();
    release();
    const rest = await collect({ [Symbol.asyncIterator]: () => stream });

    expect(first.value?.payload).toMatchObject({
      $case: "task",
      value: { id: task.id },
    });
    const last = rest.at(-1)?.payload;
    expect(last?.$case).toBe("statusUpdate");
    if (last?.$case !== "statusUpdate") return;
    expect(last.value.taskId).toBe(task.id);
    expect(last.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("cancels a running Task", async () => {
    const client = await connect({ polling: true });
    const { task, release } = await startHeld(client);

    const canceled = await client.cancelTask(
      CancelTaskRequest.fromJSON({ id: task.id }),
    );
    release();

    expect(canceled.id).toBe(task.id);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("lists Tasks a page at a time", async () => {
    const client = await connect();
    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      await client.sendMessage(message(id));
    }

    const first = await client.listTasks(
      ListTasksRequest.fromJSON({ pageSize: 2 }),
    );
    const second = await client.listTasks(
      ListTasksRequest.fromJSON({
        pageSize: 2,
        pageToken: first.nextPageToken,
      }),
    );

    expect(first.tasks).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    expect(first.nextPageToken).not.toBe("");
    expect(second.tasks).toHaveLength(1);
    expect(second.nextPageToken).toBe("");
    const ids = [...first.tasks, ...second.tasks].map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("creates, gets, lists and deletes a push notification config", async () => {
    const client = await connect();
    const task = asTask(await client.sendMessage(message("msg-a")));

    const created = await client.createTaskPushNotificationConfig(
      TaskPushNotificationConfig.fromJSON({
        taskId: task.id,
        url: "https://203.0.113.10/push",
        token: "client-verification-token",
        authentication: { scheme: "Bearer", credentials: "client-secret" },
      }),
    );
    expect(created).toMatchObject({
      taskId: task.id,
      url: "https://203.0.113.10/push",
    });
    expect(created.id).not.toBe("");

    const got = await client.getTaskPushNotificationConfig(
      GetTaskPushNotificationConfigRequest.fromJSON({
        taskId: task.id,
        id: created.id,
      }),
    );
    expect(got).toMatchObject({ id: created.id, taskId: task.id });

    const listed = await client.listTaskPushNotificationConfig(
      ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }),
    );
    expect(listed.configs.map((c) => c.id)).toEqual([created.id]);

    await client.deleteTaskPushNotificationConfig(
      DeleteTaskPushNotificationConfigRequest.fromJSON({
        taskId: task.id,
        id: created.id,
      }),
    );
    const after = await client.listTaskPushNotificationConfig(
      ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }),
    );
    expect(after.configs).toEqual([]);
  });

  it("surfaces an unknown Task as the SDK's TaskNotFoundError", async () => {
    const client = await connect();

    await expect(
      client.getTask(GetTaskRequest.fromJSON({ id: "task-unknown" })),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
