import {
  convertToModelMessages,
  generateText,
  isToolUIPart,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { chatSummary, workspace as workspaceTable } from "../db/schema.ts";
import { clearStaleToolResults } from "../runs/tool-result-clearing.ts";
import { LOAD_SKILL_TOOL_NAME } from "../tools/turn-tool-names.ts";
import {
  TRANSCRIPT_SUMMARY_BACKSTOP,
  TRANSCRIPT_SUMMARY_KEEP_TURNS,
  TRANSCRIPT_SUMMARY_KEEP_TURNS_WITH_SUMMARY,
  TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
  TRANSCRIPT_SUMMARY_TRIGGER,
  TOOL_CLEARING_BATCH,
  nextTurnOccupancy,
  type ContextOccupancyReading,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import type { ScopeContext } from "../scope.ts";
import { logger } from "../logger.ts";
import { isContextOverflowError } from "./context-overflow.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { openProvider } from "./provider.ts";
import {
  contextWindowForModel,
  pointerSettingModelId,
} from "./model-capability.ts";
import { jobCallSettings, jobMaxOutputTokens } from "./reasoning.ts";
import { jobInputBudgetChars } from "./job-input-budget.ts";
import {
  isChatsOwnModel,
  resolveTaskModelProvider,
  type TaskModelWorkspace,
} from "./task-model.ts";
import {
  resolveGenerationPlan,
  type GenerationSource,
} from "../runs/agent-plan.ts";

export type ChatSummaryRow = typeof chatSummary.$inferSelect;

// why: structural, not imported; chat-execution.ts imports this module
type TranscriptSummaryQueries = {
  getAgent(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<AgentRow | null>;
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<ProviderRow | null>;
  getWorkspace(
    orgId: string,
    workspaceId: string,
  ): Promise<TaskModelWorkspace | null>;
};

import type { ProviderRow } from "./provider-write.ts";

const drizzleTranscriptSummaryQueries: TranscriptSummaryQueries = {
  async getAgent(id, orgId, workspaceId) {
    return (
      (await resolveScoped(db, "agent", id, { orgId, workspaceId }))?.row ??
      null
    );
  },
  async getProvider(id, orgId, workspaceId) {
    return (
      (await resolveScoped(db, "provider", id, { orgId, workspaceId }))?.row ??
      null
    );
  },
  async getWorkspace(orgId, workspaceId) {
    const [row] = await db
      .select({ taskModelProviderId: workspaceTable.taskModelProviderId })
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, workspaceId),
          eq(workspaceTable.organizationId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};

type AgentRow = {
  providerId: string;
  modelId: string;
  maxSteps?: number | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  seed?: number | null;
  presencePenalty?: number | null;
  frequencyPenalty?: number | null;
};

export const loadChatSummaries = async (
  chatId: string,
): Promise<ChatSummaryRow[]> =>
  db
    .select()
    .from(chatSummary)
    .where(eq(chatSummary.chatId, chatId))
    .orderBy(desc(chatSummary.createdAt))
    .limit(50);

export const SUMMARY_PART_LABEL = "[Summary of the earlier conversation]";

export const isSummaryUsable = (
  summary: Pick<ChatSummaryRow, "anchorId" | "coveredIds">,
  path: PlatypusUIMessage[],
): boolean => {
  const anchorIndex = path.findIndex(
    (message) => message.id === summary.anchorId,
  );
  if (anchorIndex < 0) return false;
  const live = path.slice(0, anchorIndex + 1).map((message) => message.id);
  if (!sameIds(live, summary.coveredIds)) return false;
  return path[anchorIndex + 1]?.role === "user";
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

const depthOf = (index: ReadonlyMap<string, number>, id: string): number =>
  index.get(id) ?? -1;

type LoadSkillUIPart = Extract<
  PlatypusUIMessage["parts"][number],
  { type: `tool-${typeof LOAD_SKILL_TOOL_NAME}` }
>;

const skillLoadOf = (message: PlatypusUIMessage) => {
  const parts = message.parts.filter(
    (part): part is LoadSkillUIPart =>
      isToolUIPart(part) && part.type === `tool-${LOAD_SKILL_TOOL_NAME}`,
  );
  const call = parts.find(
    (part) =>
      "input" in part &&
      typeof (part.input as { name?: unknown }).name === "string",
  );
  if (!call) return undefined;
  const result = parts.find(
    (part) =>
      part.state === "output-available" || part.state === "output-error",
  );
  if (!result) return undefined;
  const name = (call.input as { name: string }).name;
  // why: a seeded pair's output is a SkillLoadResult; a resumed stream's may be its string
  const output: unknown =
    result.state === "output-error" ? result.errorText : result.output;
  const body =
    typeof output === "string"
      ? output
      : typeof output === "object" &&
          output !== null &&
          "body" in output &&
          typeof output.body === "string"
        ? output.body
        : undefined;
  return body !== undefined ? { name, body } : undefined;
};

const summarisedSkillLoads = (
  messages: PlatypusUIMessage[],
): Map<string, { name: string; body: string }> => {
  const loads = new Map<string, { name: string; body: string }>();
  for (const message of messages) {
    const load = skillLoadOf(message);
    if (load) loads.set(load.name, load);
  }
  return loads;
};

const keptTailSkillNames = (messages: PlatypusUIMessage[]): Set<string> => {
  const names = new Set<string>();
  for (const message of messages) {
    const load = skillLoadOf(message);
    if (load) names.add(load.name);
  }
  return names;
};

const SKILL_REINJECTION_PART = (name: string) => `\n[Loaded Skill: ${name}]`;

// why: Skill bodies ride as text; convertToModelMessages drops tool parts on a user message
const withSummary = (
  firstKept: PlatypusUIMessage,
  summaryText: string,
  skillLoads: Array<{ name: string; body: string }>,
): PlatypusUIMessage => ({
  ...firstKept,
  parts: [
    { type: "text", text: `${SUMMARY_PART_LABEL}\n${summaryText}` },
    ...skillLoads.map(({ name, body }) => ({
      type: "text" as const,
      text: `${SKILL_REINJECTION_PART(name)}\n${body}`,
    })),
    ...firstKept.parts,
  ],
});

export const applyTranscriptSummary = (
  path: PlatypusUIMessage[],
  summaries: readonly ChatSummaryRow[],
): { messages: PlatypusUIMessage[]; summary: ChatSummaryRow | undefined } => {
  const index = new Map(path.map((message, i) => [message.id, i]));
  const usable = summaries
    .filter((summary) => index.has(summary.anchorId))
    .filter((summary) => isSummaryUsable(summary, path))
    .sort(
      (a, b) =>
        depthOf(index, b.anchorId) - depthOf(index, a.anchorId) ||
        summaries.indexOf(a) - summaries.indexOf(b),
    );
  const summary = usable[0];
  if (!summary) return { messages: path, summary: undefined };

  const anchorIndex = depthOf(index, summary.anchorId);
  const firstKept = path[anchorIndex + 1];
  if (!firstKept) return { messages: path, summary };

  const covered = path.slice(0, anchorIndex + 1);
  const kept = path.slice(anchorIndex + 1);
  const alreadyLoaded = keptTailSkillNames(kept);
  const reInjected = [...summarisedSkillLoads(covered).values()].filter(
    (load) => !alreadyLoaded.has(load.name),
  );

  return {
    messages: [
      withSummary(firstKept, summary.text, reInjected),
      ...kept.slice(1),
    ],
    summary,
  };
};

export const lastOccupancyReading = (
  messages: PlatypusUIMessage[],
): { reading: ContextOccupancyReading; summaryId?: string } | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    // why: null marks an erased reading; stop there, never read an older one past it
    const message = messages[i];
    if (message === undefined) continue;
    const reading = message.metadata?.contextOccupancy;
    if (reading === undefined) continue;
    if (reading === null) return undefined;
    return { reading, summaryId: message.metadata?.summaryId };
  }
  return undefined;
};

export const projectedOccupancyOf = (
  messages: PlatypusUIMessage[],
): { projected: number; summaryId?: string } | undefined => {
  const last = lastOccupancyReading(messages);
  if (!last) return undefined;
  const projected = nextTurnOccupancy(last.reading);
  if (projected === undefined) return undefined;
  return { projected, summaryId: last.summaryId };
};

export const transcriptSummaryDueAfterTurn = (
  projectedOccupancy: number | undefined,
  contextWindow: number | undefined,
): boolean =>
  contextWindow !== undefined &&
  projectedOccupancy !== undefined &&
  contextWindow > 0 &&
  projectedOccupancy / contextWindow >= TRANSCRIPT_SUMMARY_TRIGGER;

const overflowedReply = (
  path: PlatypusUIMessage[],
): { summaryId?: string } | undefined => {
  const metadata = path.findLast(
    (message) => message.role === "assistant",
  )?.metadata;
  return metadata?.contextOverflow === true
    ? { summaryId: metadata.summaryId }
    : undefined;
};

export const transcriptSummaryBackstopDue = (args: {
  projectedOccupancy: number | undefined;
  contextWindow: number | undefined;
  usableSummary: ChatSummaryRow | undefined;
  readingSummaryId: string | undefined;
  summaries: readonly ChatSummaryRow[];
  path: PlatypusUIMessage[];
}): boolean => {
  const {
    projectedOccupancy,
    contextWindow,
    usableSummary,
    readingSummaryId,
    summaries,
    path,
  } = args;
  const stale =
    readingSummaryId !== undefined &&
    !summaries.some(
      (summary) =>
        summary.id === readingSummaryId && isSummaryUsable(summary, path),
    );
  const overflowed = overflowedReply(path);
  const overflowDue =
    overflowed !== undefined && usableSummary?.id === overflowed.summaryId;
  const overTheWall =
    contextWindow !== undefined &&
    projectedOccupancy !== undefined &&
    contextWindow > 0 &&
    projectedOccupancy / contextWindow >= TRANSCRIPT_SUMMARY_BACKSTOP &&
    usableSummary === undefined;
  return stale || overflowDue || overTheWall;
};

export const transcriptSummaryKeptTurns = (
  readingSummaryId: string | undefined,
): number =>
  readingSummaryId === undefined
    ? TRANSCRIPT_SUMMARY_KEEP_TURNS
    : TRANSCRIPT_SUMMARY_KEEP_TURNS_WITH_SUMMARY;

export const summaryAnchorIndex = (
  path: PlatypusUIMessage[],
  keptTurns: number,
): number | undefined => {
  const turnEnds = path
    .map((message, i) => {
      const next = path[i + 1];
      return message.role === "assistant" &&
        (i === path.length - 1 || next?.role === "user")
        ? i
        : null;
    })
    .filter((i): i is number => i !== null);
  return turnEnds.at(-(keptTurns + 1));
};

const deepestPriorSummary = (
  path: PlatypusUIMessage[],
  summaries: readonly ChatSummaryRow[],
  anchorIndex: number,
): ChatSummaryRow | undefined => {
  const index = new Map(path.map((message, i) => [message.id, i]));
  const onPath = summaries
    .filter((summary) => {
      const existing = index.get(summary.anchorId);
      return existing !== undefined && existing < anchorIndex;
    })
    .sort(
      (a, b) =>
        depthOf(index, b.anchorId) - depthOf(index, a.anchorId) ||
        summaries.indexOf(a) - summaries.indexOf(b),
    );
  return onPath[0];
};

const incrementalInput = (
  previousSummary: ChatSummaryRow | undefined,
  path: PlatypusUIMessage[],
  newAnchorIndex: number,
): { priorText?: string; messages: PlatypusUIMessage[] } => {
  const previousIndex = previousSummary
    ? path.findIndex((message) => message.id === previousSummary.anchorId)
    : -1;
  const start = previousIndex >= 0 ? previousIndex + 1 : 0;
  return {
    ...(previousSummary ? { priorText: previousSummary.text } : {}),
    messages: path.slice(start, newAnchorIndex + 1),
  };
};

const TRANSCRIPT_SUMMARY_PROMPT = (steering?: string) =>
  `You are writing the handoff summary of the earlier part of a conversation. A model that continues the conversation reads your summary instead of those messages, so anything you leave out is lost for good.

If the input begins with "[Summary so far]", that is the summary of the part before it. Merge it into your new summary. The newer messages take precedence: update or remove an item they resolved, superseded or made stale. Never drop something only because it came from the earlier summary. A carried-in user request that is fully answered — as the earlier summary records it, or as the newer messages answer it — is the one exception: "## User requests" says what to keep and when to drop it.

Search results and pages that were read may appear only as cleared placeholders. Rely on what the assistant's replies concluded from them, and never present a result you cannot see as fact.

The final message, which asks you to write the summary, is the instruction for this task, not part of the conversation. Leave it out of every section.

Before you write, go through the conversation in order and note every user request, every answer that produced something, every tool finding and every decision. Do not include these notes in the summary.

Then write the summary under exactly these headings, in this order, starting directly with the first heading. Write "None." under a heading that has nothing to report.

## Intent
One paragraph: what the user is trying to achieve overall and why, including who they are or which organisation they represent where that was established.

## User requests
**Standing instructions.** A short, deduplicated list of the durable instructions, constraints and preferences that user requests set, whether they came from the earlier summary or from this conversation — language, format, audience, deadlines, "not X but Y". When a newer message supersedes or contradicts one, update it or remove it; never list both.

**Open requests.** A request carried in from the earlier summary that is not fully answered stays word for word, in its original language, shortened only by the about-300-character rule below. A request that is fully answered — whether the earlier summary records it as answered or the newer messages answer it — is dropped: its standing instructions are in the list above, and it is not quoted again.

**This pass's user messages.** Count the user messages in the conversation itself, leaving out the "[Summary so far]" message and the final message that asks for this summary; each one gets its own bullet, short follow-ups included. Copy each of them verbatim, in its original language, in order, one bullet each. Shorten only a message longer than about 300 characters, keeping every instruction, constraint, preference and correction (language, format, audience, deadlines, "not X but Y"). There must be exactly one bullet per message you counted, and each of those bullets ends with whether it was fully answered. A request answered in this pass is dropped on the next pass, once the instructions it set are listed under Standing instructions; a request that is not fully answered moves to Open requests and stays word for word.

## Key facts and decisions
The facts established and the decisions made that later answers depend on, with exact values: names, numbers, dates, versions, ids, URLs. Never write "a value was set" or "several options were discussed". When the conversation states a date, number or name more than once with different values, give both and say they disagree instead of picking one.

## Deliverables
Each substantial thing the assistant produced (a guide, plan, policy, document, file, code, table): its title, language, format and audience, and its essential content: its main sections and the concrete recommendations, figures and dates in it, in enough detail that the continuing model could extend or reproduce it without asking the user again. "A plan was written" is not enough.

## Sources and tool findings
The tools used and what they found that still matters: sources consulted (with URLs where given), the key finding from each, and the sources or tool calls that failed or returned nothing.

## Corrections and dead ends
Mistakes found and fixed, approaches tried and dropped, and anything the user corrected or rejected, so it is not repeated.

## Open questions and things left to solve
Unanswered questions, requests the user made that were not fully delivered, unfinished work, pending decisions or approvals, and anything the assistant offered or promised to do later. Do not add suggestions of your own.

## Current state
What was being worked on where this part of the conversation ends, and whether the last user request was fully answered. Keep three things apart: what was done in the conversation, what was only proposed or planned, and what the user said already exists on their side. Only the assistant's own work (documents written, research performed) counts as done. Every step inside a plan, roadmap, policy or template the assistant wrote is planned, not done, even when it has a date in the past: never describe it as underway or finished unless the user said so.

Keep the headings exactly as written above, in English, whatever language the conversation is in. Write the text under them in the language the conversation is mostly written in, but quote user messages in their original language. The summary must stand alone: never refer to "the conversation above" or "earlier messages".

Length: keep specifics rather than brevity, in dense bullet points rather than prose. Scale it to what the conversation holds: a short exchange needs a line or two per heading; a long conversation with substantial deliverables can need 1,500–2,500 words. Do not pad.
${steering !== undefined ? `The requester's instruction for this summary, which takes precedence over the length guidance above: ${steering}` : ""}`;

// why: a trailing assistant message is continued, not answered; end on a user turn
export const TRANSCRIPT_SUMMARY_REQUEST =
  "Write the summary now, following the instructions you were given.";

export type TranscriptSummaryModel = {
  model: LanguageModel;
  modelId: string;
  settings?: ReturnType<typeof jobCallSettings>;
  maxOutputTokens?: number;
  outputCeiling?: number;
  contextWindow?: number;
};

export type TranscriptSummaryModels = {
  chat: TranscriptSummaryModel;
  task?: TranscriptSummaryModel;
};

export type TranscriptSummaryPassInput = {
  chatId: string;
  models: TranscriptSummaryModels;
  path: PlatypusUIMessage[];
  triggeredFromOccupancy: number;
  previousSummary: ChatSummaryRow | undefined;
  readingSummaryId: string | undefined;
  readOnlyToolNames?: ReadonlySet<string>;
  signal?: AbortSignal;
  instruction?: string;
  keptTurns?: number;
};

export const takeTranscriptSummary = async (
  input: TranscriptSummaryPassInput,
): Promise<ChatSummaryRow | undefined> => {
  const {
    chatId,
    models,
    path,
    triggeredFromOccupancy,
    previousSummary,
    readingSummaryId,
    readOnlyToolNames,
    signal,
    instruction,
    keptTurns = transcriptSummaryKeptTurns(readingSummaryId),
  } = input;

  const { chat: chatModel, task: taskModel } = models;

  let anchorIndex = summaryAnchorIndex(path, keptTurns);
  if (anchorIndex === undefined) return undefined;

  type SummaryInput = {
    anchorIndex: number;
    priorText?: string;
    modelMessages: ModelMessage[];
  };

  const anchorInput = async (index: number): Promise<SummaryInput> => {
    const { priorText, messages } = incrementalInput(
      previousSummary,
      path,
      index,
    );
    return {
      anchorIndex: index,
      ...(priorText !== undefined ? { priorText } : {}),
      modelMessages: await clearedModelMessages(messages, readOnlyToolNames),
    };
  };

  const outputCap = (entry: TranscriptSummaryModel): number =>
    Math.min(
      entry.maxOutputTokens ?? TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
      entry.outputCeiling ?? Infinity,
    );

  const attempt = async (
    entry: TranscriptSummaryModel,
    input: SummaryInput,
  ): Promise<
    | { kind: "row"; row: ChatSummaryRow }
    | { kind: "unusable"; finishReason: FinishReason }
    | { kind: "error"; error: unknown }
    | { kind: "storage-error" }
  > => {
    try {
      const result = await generateText({
        model: entry.model,
        instructions: TRANSCRIPT_SUMMARY_PROMPT(instruction),
        messages: [
          ...(input.priorText !== undefined
            ? [
                {
                  role: "user" as const,
                  content: `[Summary so far]\n${input.priorText}`,
                },
              ]
            : []),
          ...input.modelMessages,
          { role: "user" as const, content: TRANSCRIPT_SUMMARY_REQUEST },
        ],
        ...entry.settings,
        maxOutputTokens: outputCap(entry),
        abortSignal: signal,
      });

      if (result.finishReason === "length" || result.text.trim() === "") {
        return { kind: "unusable", finishReason: result.finishReason };
      }

      const anchor = path[input.anchorIndex];
      if (anchor === undefined) {
        return {
          kind: "error",
          error: new Error("The summary anchor is no longer on the path"),
        };
      }
      const anchorId = anchor.id;
      const row: ChatSummaryRow = {
        id: defaultSummaryId(),
        chatId,
        anchorId,
        coveredIds: path
          .slice(0, input.anchorIndex + 1)
          .map((message) => message.id),
        text: result.text,
        stats: {
          modelId: entry.modelId,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          triggeredFromOccupancy,
        },
        createdAt: new Date(),
      };
      try {
        await db.insert(chatSummary).values(row);
      } catch (error) {
        logger.error({ error, chatId }, "Error storing a transcript summary");
        return { kind: "storage-error" };
      }
      logger.info(
        {
          chatId,
          anchorId,
          modelId: entry.modelId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          trigger: triggeredFromOccupancy,
        },
        "Transcript summary taken",
      );
      return { kind: "row", row };
    } catch (error) {
      return { kind: "error", error };
    }
  };

  // why: chars ÷ 4 over-counts, so a misjudged input falls to the Chat's model, never lost
  const fitsDeclaredWindow = (
    entry: TranscriptSummaryModel,
    input: SummaryInput,
  ): boolean =>
    entry.contextWindow === undefined ||
    TRANSCRIPT_SUMMARY_PROMPT(instruction).length +
      (input.priorText?.length ?? 0) +
      JSON.stringify(input.modelMessages).length +
      TRANSCRIPT_SUMMARY_REQUEST.length <=
      jobInputBudgetChars(entry.contextWindow, outputCap(entry));

  let summaryInput = await anchorInput(anchorIndex);

  // why: a server may silently truncate an overlong prompt; no error would trigger fallback
  if (taskModel && !fitsDeclaredWindow(taskModel, summaryInput)) {
    logger.info(
      {
        chatId,
        modelId: taskModel.modelId,
        contextWindow: taskModel.contextWindow,
        maxOutputTokens: outputCap(taskModel),
        fallbackModelId: chatModel.modelId,
      },
      "Transcript summary skipped the task model: the input exceeds its declared context window",
    );
  } else if (taskModel) {
    const outcome = await attempt(taskModel, summaryInput);
    if (outcome.kind === "row") return outcome.row;
    if (outcome.kind === "storage-error") return undefined;
    logger.warn(
      {
        chatId,
        modelId: taskModel.modelId,
        fallbackModelId: chatModel.modelId,
        ...(outcome.kind === "error"
          ? { error: outcome.error }
          : { finishReason: outcome.finishReason }),
      },
      outcome.kind === "unusable"
        ? "Transcript summary task model came back blank or cut off; falling back to the Chat's model"
        : "Transcript summary task model failed; falling back to the Chat's model",
    );
  }

  for (let retry = 0; retry < 2; retry += 1) {
    if (retry > 0) {
      summaryInput = await anchorInput(anchorIndex);
    }
    const outcome = await attempt(chatModel, summaryInput);
    if (outcome.kind === "row") return outcome.row;
    if (outcome.kind === "unusable") {
      logger.warn(
        { chatId, finishReason: outcome.finishReason },
        "Transcript summary came back blank or cut off; proceeding without one",
      );
      return undefined;
    }
    if (outcome.kind === "storage-error") return undefined;
    if (isContextOverflowError(outcome.error) && retry === 0) {
      const earlier = summaryAnchorIndex(path, keptTurns + 1);
      if (earlier === undefined || earlier >= anchorIndex) break;
      anchorIndex = earlier;
      logger.warn(
        { chatId, error: outcome.error },
        "Transcript summary call overflowed; retrying with an earlier anchor",
      );
      continue;
    }
    logger.warn(
      { chatId, error: outcome.error },
      "Transcript summary failed; proceeding without one",
    );
    return undefined;
  }
  return undefined;
};

const defaultSummaryId = (): string => `sum_${randomUUID()}`;

const clearedModelMessages = async (
  messages: PlatypusUIMessage[],
  readOnlyToolNames?: ReadonlySet<string>,
): Promise<ModelMessage[]> =>
  clearStaleToolResults(
    await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    { keepRecent: 0, batchSize: TOOL_CLEARING_BATCH },
    (toolName) => readOnlyToolNames?.has(toolName) ?? false,
  );

export type SummariserSource =
  { agentId: string } | { providerId: string; modelId: string };

const resolveSummariserModels = async (
  source: SummariserSource,
  orgId: string,
  workspaceId: string,
  sessionId: string,
  queries: TranscriptSummaryQueries,
): Promise<TranscriptSummaryModels> => {
  const generation: GenerationSource =
    "agentId" in source
      ? {
          agent: await mustGetAgent(
            source.agentId,
            orgId,
            workspaceId,
            queries,
          ),
        }
      : { providerId: source.providerId, modelId: source.modelId };
  const { plan, provider, resolvedModelId } = await resolveGenerationPlan(
    generation,
    { orgId, workspaceId, sessionId },
    queries,
  );
  return withTaskSummariserModel({
    orgId,
    workspaceId,
    chat: {
      model: plan.model,
      modelId: resolvedModelId,
      ...(plan.maxOutputTokens !== undefined
        ? { outputCeiling: plan.maxOutputTokens }
        : {}),
    },
    chatProviderId: provider.id,
    sessionId,
    queries,
  });
};

const withTaskSummariserModel = async (args: {
  orgId: string;
  workspaceId: string;
  chat: TranscriptSummaryModel;
  chatProviderId: string;
  sessionId: string;
  queries: TranscriptSummaryQueries;
}): Promise<TranscriptSummaryModels> => {
  const { orgId, workspaceId, chat, chatProviderId, sessionId, queries } = args;
  try {
    const workspace = await queries.getWorkspace(orgId, workspaceId);
    const taskProvider = await resolveTaskModelProvider(
      {
        workspace,
        fallbackProviderId: chatProviderId,
        orgId,
        workspaceId,
      },
      queries,
    );
    if (!taskProvider.provider) {
      logger.warn(
        {
          orgId,
          workspaceId,
          providerId: taskProvider.providerId,
          fromTaskModelOverride: taskProvider.fromOverride,
        },
        "Transcript summary task model skipped: provider is not visible in this workspace",
      );
      return { chat };
    }
    const taskModelId = taskProvider.provider.taskModelId;
    if (taskModelId.trim() === "") return { chat };
    const settings = jobCallSettings(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
      taskProvider.provider.taskModelSettings,
    );
    const isChatModel = isChatsOwnModel({
      taskProviderId: taskProvider.provider.id,
      taskModelId,
      chatProviderId,
      chatModelId: chat.modelId,
    });
    const maxOutputTokens = jobMaxOutputTokens(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
      taskProvider.provider.taskModelSettings,
      TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
    );
    if (isChatModel) {
      return {
        chat: {
          model: chat.model,
          modelId: chat.modelId,
          settings,
          maxOutputTokens,
        },
      };
    }
    const contextWindow = contextWindowForModel(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
    );
    return {
      task: {
        model: openProvider(taskProvider.provider, { sessionId }).languageModel(
          pointerSettingModelId(taskModelId),
        ),
        modelId: taskModelId,
        settings,
        maxOutputTokens,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      },
      chat,
    };
  } catch (error) {
    logger.warn(
      { error, orgId, workspaceId },
      "Transcript summary task model unavailable; using the Chat's model",
    );
    return { chat };
  }
};

const mustGetAgent = async (
  agentId: string,
  orgId: string,
  workspaceId: string,
  queries: Pick<TranscriptSummaryQueries, "getAgent">,
): Promise<AgentRow> => {
  const agent = await queries.getAgent(agentId, orgId, workspaceId);
  if (!agent) {
    throw new Error(
      `Agent '${agentId}' no longer resolves; cannot summarise this Chat`,
    );
  }
  return agent;
};

const inFlightSummaries = new Map<
  string,
  Promise<ChatSummaryRow | undefined>
>();

export const registerTranscriptSummary = (
  chatId: string,
  start: () => Promise<ChatSummaryRow | undefined>,
): Promise<ChatSummaryRow | undefined> => {
  const existing = inFlightSummaries.get(chatId);
  if (existing) return existing;

  // why: registered before start runs, synchronously, so a caller reached from it joins
  const settled = Promise.withResolvers<ChatSummaryRow | undefined>();
  const inFlight = settled.promise.finally(() => {
    if (inFlightSummaries.get(chatId) === inFlight) {
      inFlightSummaries.delete(chatId);
    }
  });
  inFlightSummaries.set(chatId, inFlight);

  try {
    start().then(settled.resolve, settled.reject);
  } catch (error) {
    settled.reject(error);
  }
  return inFlight;
};

const takeFromReading = (args: {
  chatId: string;
  models: TranscriptSummaryModels;
  path: PlatypusUIMessage[];
  summaries: readonly ChatSummaryRow[];
  triggeredFromOccupancy: number | undefined;
  readingSummaryId: string | undefined;
  readOnlyToolNames?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<ChatSummaryRow | undefined> => {
  const anchorIndex = summaryAnchorIndex(
    args.path,
    transcriptSummaryKeptTurns(args.readingSummaryId),
  );
  return takeTranscriptSummary({
    chatId: args.chatId,
    models: args.models,
    path: args.path,
    triggeredFromOccupancy: args.triggeredFromOccupancy ?? 0,
    previousSummary: deepestPriorSummary(
      args.path,
      args.summaries,
      anchorIndex ?? 0,
    ),
    readingSummaryId: args.readingSummaryId,
    readOnlyToolNames: args.readOnlyToolNames,
    signal: args.signal,
  });
};

export const beforeTurn = async (args: {
  chatId?: string;
  path: PlatypusUIMessage[];
  summaries: ChatSummaryRow[];
  contextWindow?: number;
  model: LanguageModel;
  modelId: string;
  outputCeiling?: number;
  taskModel?: {
    scope: ScopeContext;
    providerId: string;
  };
  readOnlyToolNames?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<{
  messages: PlatypusUIMessage[];
  summaryId?: string;
  backstopEngaged: boolean;
}> => {
  const {
    chatId,
    path,
    contextWindow,
    model,
    modelId,
    outputCeiling,
    taskModel,
    readOnlyToolNames,
    signal,
  } = args;
  let summaries = args.summaries;
  let summaryRead = applyTranscriptSummary(path, summaries);
  const reading = projectedOccupancyOf(path);
  let backstopEngaged = false;

  if (
    chatId !== undefined &&
    transcriptSummaryBackstopDue({
      projectedOccupancy: reading?.projected,
      contextWindow,
      usableSummary: summaryRead.summary,
      readingSummaryId: reading?.summaryId,
      summaries,
      path,
    })
  ) {
    const chat: TranscriptSummaryModel = {
      model,
      modelId,
      ...(outputCeiling !== undefined ? { outputCeiling } : {}),
    };
    const summary = await registerTranscriptSummary(chatId, async () => {
      const models =
        taskModel === undefined
          ? { chat }
          : await withTaskSummariserModel({
              orgId: taskModel.scope.orgId,
              workspaceId: taskModel.scope.workspaceId,
              chat,
              chatProviderId: taskModel.providerId,
              sessionId: chatId,
              queries: drizzleTranscriptSummaryQueries,
            });
      return takeFromReading({
        chatId,
        models,
        path,
        summaries,
        triggeredFromOccupancy: reading?.projected,
        readingSummaryId: reading?.summaryId,
        readOnlyToolNames,
        signal,
      });
    });
    if (summary !== undefined) {
      summaries = await loadChatSummaries(chatId);
      summaryRead = applyTranscriptSummary(path, summaries);
      backstopEngaged = summaryRead.summary !== undefined;
    }
  }

  return {
    messages: summaryRead.messages,
    ...(summaryRead.summary ? { summaryId: summaryRead.summary.id } : {}),
    backstopEngaged,
  };
};

export const afterTurn = (args: {
  chatId: string;
  orgId: string;
  workspaceId: string;
  path: PlatypusUIMessage[];
  contextWindow?: number;
  source: SummariserSource;
  readOnlyToolNames?: ReadonlySet<string>;
}): void => {
  const {
    chatId,
    orgId,
    workspaceId,
    path,
    contextWindow,
    source,
    readOnlyToolNames,
  } = args;
  const reading = projectedOccupancyOf(path);
  const overflowed = overflowedReply(path);
  if (
    !overflowed &&
    !transcriptSummaryDueAfterTurn(reading?.projected, contextWindow)
  ) {
    return;
  }
  const readingSummaryId = overflowed
    ? overflowed.summaryId
    : reading?.summaryId;

  void registerTranscriptSummary(chatId, async () => {
    const models = await resolveSummariserModels(
      source,
      orgId,
      workspaceId,
      chatId,
      drizzleTranscriptSummaryQueries,
    );
    return takeFromReading({
      chatId,
      models,
      path,
      summaries: await loadChatSummaries(chatId),
      triggeredFromOccupancy: reading?.projected,
      readingSummaryId,
      readOnlyToolNames,
    });
  }).catch((error) => {
    logger.error(
      { error, chatId },
      "After-turn transcript summary failed; the next turn's finish retries",
    );
  });
};

export const compactTranscript = async (args: {
  chatId: string;
  orgId: string;
  workspaceId: string;
  source: SummariserSource;
  path: PlatypusUIMessage[];
  instruction?: string;
}): Promise<ChatSummaryRow | undefined> => {
  const { chatId, orgId, workspaceId, source, path, instruction } = args;
  const anchorIndex = summaryAnchorIndex(path, 0);
  if (anchorIndex === undefined) return undefined;

  // why: an in-flight after-turn pass lacks the instruction and keeps a tail; await, not join
  const claim = { ours: false };
  const start = async () => {
    claim.ours = true;
    const models = await resolveSummariserModels(
      source,
      orgId,
      workspaceId,
      chatId,
      drizzleTranscriptSummaryQueries,
    );
    return takeTranscriptSummary({
      chatId,
      models,
      path,
      triggeredFromOccupancy: projectedOccupancyOf(path)?.projected ?? 0,
      previousSummary: deepestPriorSummary(
        path,
        await loadChatSummaries(chatId),
        anchorIndex,
      ),
      readingSummaryId: undefined,
      instruction,
      keptTurns: 0,
    });
  };
  // why: start runs synchronously to its first await, so claim is settled on return
  const first = registerTranscriptSummary(chatId, start);
  if (claim.ours) return first;
  await first.catch(() => undefined);
  return registerTranscriptSummary(chatId, start);
};
