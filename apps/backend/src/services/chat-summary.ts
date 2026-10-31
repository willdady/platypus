import {
  convertToModelMessages,
  generateText,
  isToolUIPart,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { chatSummary } from "../db/schema.ts";
import { clearStaleToolResults } from "../runs/tool-result-clearing.ts";
import { LOAD_SKILL_TOOL_NAME } from "../tools/turn-tool-names.ts";
import {
  TRANSCRIPT_SUMMARY_BACKSTOP,
  TRANSCRIPT_SUMMARY_KEEP_TURNS,
  TRANSCRIPT_SUMMARY_KEEP_TURNS_WITH_SUMMARY,
  TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
  TRANSCRIPT_SUMMARY_TRIGGER,
  nextTurnOccupancy,
  type ContextOccupancyReading,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import { logger } from "../logger.ts";
import { isContextOverflowError } from "./context-overflow.ts";
import { resolveScoped } from "./scoped-resource.ts";
import {
  resolveGenerationPlan,
  type GenerationSource,
} from "../runs/agent-plan.ts";

/**
 * A durable **Transcript summary** of a Chat's older Transcript (ADR-0041,
 * issue #1716): everything the module that takes, reads and applies a summary
 * shares, so the turn's read path, the turn's finish and the backstop all
 * decide the same way.
 *
 * Rows are immutable facts about a path — "everything from the root to
 * message X, condensed" — checked for usability when they are READ. Nothing
 * here ever writes a `chat_message`; the stored Transcript never changes.
 */

export type ChatSummaryRow = typeof chatSummary.$inferSelect;

/** The data-access surface the pass's model resolution reads (a slice of
 *  `ChatTurnQueries`, stated structurally so this module never imports its
 *  caller — `chat-execution.ts` imports this one). */
export type TranscriptSummaryQueries = {
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
};

import type { ProviderRow } from "./provider-write.ts";

/**
 * The production `TranscriptSummaryQueries`: Scoped-resource reads, exactly as
 * a Chat turn serves them (ADR-0007), so a Shared (org-scoped) Provider/Agent
 * resolves for a summary pass the way it resolved the turn.
 */
export const drizzleTranscriptSummaryQueries: TranscriptSummaryQueries = {
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
};

/**
 * The live `agent` row a generation plan re-resolves from, stated minimally
 * (a SamplingSource satisfies the rest of `GenerationSource`'s agent shape).
 * Production passes the real `agent` table row; tests pass a fixture.
 */
export type AgentRow = {
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

/** The Chat's summaries, newest first. */
export const loadChatSummaries = async (
  chatId: string,
): Promise<ChatSummaryRow[]> =>
  db
    .select()
    .from(chatSummary)
    .where(eq(chatSummary.chatId, chatId))
    .orderBy(desc(chatSummary.createdAt))
    .limit(50);

/** The label the summary text part opens with — all the model gets to know
 *  that this was not something the User said (ADR-0041). */
export const SUMMARY_PART_LABEL = "[Summary of the earlier conversation]";

/**
 * Whether a summary is usable on `path`: its anchor is on the path, and its
 * `coveredIds` are exactly the live path ids from the root through the anchor.
 *
 * A Delete inside the range changes the live path under the anchor, so the
 * pair no longer matches and the summary is skipped — the read-time check that
 * replaces any invalidation write (ADR-0041). A delete in the kept tail, or an
 * edit/regenerate that adds a sibling below the range, never touches the pair.
 */
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
  // The anchor must still END a turn: the summary rides the first kept user
  // message, which exists exactly when the anchor is followed by one. A
  // Delete of the user message that opened the turn after the anchor leaves
  // the next assistant floating on the path, and the summary has nothing to
  // ride — so it reads as unusable and the backstop takes a fresh one, the
  // same outcome as a Delete inside the range.
  return path[anchorIndex + 1]?.role === "user";
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** A message's index on the path, as a depth two anchors can be compared on. */
const depthOf = (index: ReadonlyMap<string, number>, id: string): number =>
  index.get(id) ?? -1;

/** The static UI part type a completed `loadSkill` call+result pair uses. */
type LoadSkillUIPart = Extract<
  PlatypusUIMessage["parts"][number],
  { type: `tool-${typeof LOAD_SKILL_TOOL_NAME}` }
>;

/**
 * The one completed `loadSkill` pair a message holds, or `undefined`: the
 * name and the loaded body, proved complete — a call whose result is not
 * beside it is an in-flight or failed load.
 */
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
  // The seeded pair's output is a `SkillLoadResult`; a resumed stream's may be
  // its string form. Anything else is not a body worth re-injecting.
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

/**
 * Every completed `loadSkill` inside the summarised range, by Skill name — the
 * LATEST load wins, so a Skill re-loaded over a long Chat re-injects the
 * version the model last acted on.
 */
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

/** The Skill names the kept tail has already loaded — re-injection skips these. */
const keptTailSkillNames = (messages: PlatypusUIMessage[]): Set<string> => {
  const names = new Set<string>();
  for (const message of messages) {
    const load = skillLoadOf(message);
    if (load) names.add(load.name);
  }
  return names;
};

/** The labelled text part a re-injected Skill body opens with. */
const SKILL_REINJECTION_PART = (name: string) => `\n[Loaded Skill: ${name}]`;

/**
 * The summary a model call receives in place of the older Transcript, as a
 * leading text part of the FIRST KEPT message — always a user message, the
 * anchor being a turn's last assistant message. NEVER a message of its own:
 * two user messages in a row are rejected by some chat templates served
 * through vLLM (ADR-0041), and the System prompt is byte-stable while a Chat
 * is active (ADR-0020).
 *
 * Skill loads from inside the summarised range are re-injected as labelled
 * text parts after the summary, deduplicated by Skill name, latest load only,
 * skipping any Skill the kept tail already loads. They ride the same user
 * message because a UI tool pair has no other alternation-preserving home:
 * `convertToModelMessages` drops tool parts on a user message, and a separate
 * assistant message would break the very alternation the summary avoids.
 */
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

/**
 * Applies the deepest usable Transcript summary to a Chat's path — the
 * send-time half of a turn's read, and the pure function the divider's
 * usability check starts from.
 *
 * Picks the usable summary whose anchor is DEEPEST on `path`; at the same
 * anchor the newest wins (`summaries` is newest-first). A Delete inside a
 * summary's range makes it unusable (`isSummaryUsable`), so the next one up
 * is tried. Returns the path unchanged, and no summary, when none is usable.
 *
 * Runs on the stored messages before file URLs are inlined or file parts
 * normalised, so files attached inside the summarised prefix are no longer
 * fetched (ADR-0041).
 */
export const applyTranscriptSummary = (
  path: PlatypusUIMessage[],
  summaries: readonly ChatSummaryRow[],
): { messages: PlatypusUIMessage[]; summary: ChatSummaryRow | undefined } => {
  const index = new Map(path.map((message, i) => [message.id, i]));
  const usable = summaries
    .filter((summary) => index.has(summary.anchorId))
    .filter((summary) => isSummaryUsable(summary, path))
    .sort(
      // Deepest first — the largest coverage wins. At one depth (several
      // rows at one anchor) the earlier row in `summaries` wins, which is the
      // newest when the caller hands them newest-first as
      // `loadChatSummaries` does.
      (a, b) =>
        depthOf(index, b.anchorId) - depthOf(index, a.anchorId) ||
        summaries.indexOf(a) - summaries.indexOf(b),
    );
  const summary = usable[0];
  if (!summary) return { messages: path, summary: undefined };

  const anchorIndex = depthOf(index, summary.anchorId);
  const firstKept = path[anchorIndex + 1];
  // An anchor is a mid-path turn boundary when usable, so there is always a
  // kept tail reaching past it; a summary whose tail has since been deleted
  // out from under it is left unread rather than forced into a view that
  // would end on an assistant boundary.
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

/**
 * The last Context occupancy reading on `messages`, and which Transcript
 * summary (if any) the turn that produced it was reading through — the
 * forward-looking shape the swing pass and the backstop both start from.
 */
export const lastOccupancyReading = (
  messages: PlatypusUIMessage[],
): { reading: ContextOccupancyReading; summaryId?: string } | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    // Absent and `null` say the same thing for a reading — occupancy is
    // unknown — but `null` still marks the message a reading was recorded on
    // and then erased, so it must not be skipped before its `summaryId` is.
    const message = messages[i];
    if (message === undefined) continue;
    const reading = message.metadata?.contextOccupancy;
    if (reading === undefined) continue;
    if (reading === null) return undefined;
    return { reading, summaryId: message.metadata?.summaryId };
  }
  return undefined;
};

/** The Projected occupancy (`nextTurnOccupancy`) of `lastOccupancyReading`, if a reading exists. */
export const projectedOccupancyOf = (
  messages: PlatypusUIMessage[],
): { projected: number; summaryId?: string } | undefined => {
  const last = lastOccupancyReading(messages);
  if (!last) return undefined;
  const projected = nextTurnOccupancy(last.reading);
  if (projected === undefined) return undefined;
  return { projected, summaryId: last.summaryId };
};

/**
 * Whether a turn whose finish produced `reading` should take a Transcript
 * summary off the response path: a declared window exists and the Projected
 * occupancy crosses {@link TRANSCRIPT_SUMMARY_TRIGGER}. Reading only, never an
 * estimate, and never a summary for a model without a declared window
 * (ADR-0018) — such a Chat never summarises.
 */
export const transcriptSummaryDueAfterTurn = (
  projectedOccupancy: number | undefined,
  contextWindow: number | undefined,
): boolean =>
  contextWindow !== undefined &&
  projectedOccupancy !== undefined &&
  contextWindow > 0 &&
  projectedOccupancy / contextWindow >= TRANSCRIPT_SUMMARY_TRIGGER;

/**
 * The last reply on `path`, when the Provider rejected its turn as too long
 * (issue #1717): the summary that turn read, if any, as `summaryId`.
 */
export const overflowedReply = (
  path: PlatypusUIMessage[],
): { summaryId?: string } | undefined => {
  const metadata = path.findLast(
    (message) => message.role === "assistant",
  )?.metadata;
  return metadata?.contextOverflow === true
    ? { summaryId: metadata.summaryId }
    : undefined;
};

/**
 * Whether the pre-turn **backstop** must run before the model is called:
 * Projected occupancy is at {@link TRANSCRIPT_SUMMARY_BACKSTOP} of the declared
 * window and no usable summary exists — the turn would otherwise send a
 * Transcript that fills (or has already overflowed) the window — or the last
 * turn's model call was rejected as too long (issue #1717). A reading taken
 * with a summary that is no longer usable is stale and due for the same
 * treatment even beneath the backstop wall: that reading does not describe the
 * view this turn will send, so the turn could overflow without any wall being
 * crossed.
 */
export const transcriptSummaryBackstopDue = (args: {
  projectedOccupancy: number | undefined;
  contextWindow: number | undefined;
  /** The usable summary the turn's read found, if any. */
  usableSummary: ChatSummaryRow | undefined;
  /** The summary id recorded on the last reading, or undefined. */
  readingSummaryId: string | undefined;
  /** The Chat's summaries, for the stale check. */
  summaries: readonly ChatSummaryRow[];
  /** The turn's path. */
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
  // The last turn overflowed (issue #1717): due unless a summary newer than
  // the one it overflowed with is already usable. The Provider's rejection is
  // the measurement, so neither a window nor a reading is needed.
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

/**
 * How many of the most recent turns a summary leaves verbatim: the reading
 * that triggers it was either taken bare, or taken with a summary in place.
 * The latter keeps only one turn, so a turn whose tail alone crossed the
 * trigger does not grow a summary on top of the one it already reads.
 */
export const transcriptSummaryKeptTurns = (
  readingSummaryId: string | undefined,
): number =>
  readingSummaryId === undefined
    ? TRANSCRIPT_SUMMARY_KEEP_TURNS
    : TRANSCRIPT_SUMMARY_KEEP_TURNS_WITH_SUMMARY;

/**
 * The index in `path` of the assistant message that ends the kept tail — the
 * anchor of the summary this pass is about to take — or `undefined` when the
 * path does not hold enough turns for a tail.
 *
 * A **turn** is a user message followed by an assistant message. A leaf
 * assistant message (the seeded `loadSkill` message a slash command appends,
 * which the turn's reply continues under the same id) counts as ending a turn
 * too. The anchor is the last assistant before the `keptTurns` most recent
 * turns.
 */
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

/**
 * The deepest summary whose anchor is on `path` strictly above `anchorIndex`
 * — the incremental base a new pass condenses from, whether it was usable (a
 * summary the turn just read) or only stale (a summary a Delete broke, whose
 * text is still an accurate base for the stretch its anchor covered).
 */
export const deepestPriorSummary = (
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

/**
 * The messages a summary pass hands the model: the previous usable summary's
 * text (the messages it covered are condensed inside it) plus the live
 * messages after its anchor — exclusive, already covered by that summary —
 * through the new anchor, inclusive.
 */
const incrementalInput = (
  previousSummary: ChatSummaryRow | undefined,
  path: PlatypusUIMessage[],
  newAnchorIndex: number,
): { priorText?: string; messages: PlatypusUIMessage[] } => {
  const previousIndex = previousSummary
    ? path.findIndex((message) => message.id === previousSummary.anchorId)
    : -1;
  // The previous summary's anchor is inside this range only when it is on the
  // live path; a summary whose anchor is off the path is unusable and should
  // never have been offered as the base.
  const start = previousIndex >= 0 ? previousIndex + 1 : 0;
  return {
    ...(previousSummary ? { priorText: previousSummary.text } : {}),
    messages: path.slice(start, newAnchorIndex + 1),
  };
};

/**
 * The structured handoff a Transcript summary is written from: what the
 * conversation intended, decided and concluded, what files and tools were
 * touched, what is still open, and where it stands — compactly, with an
 * explicit length target. An optional steering instruction (the User's, from
 * `/compact`) tells the pass what to keep.
 */
export const TRANSCRIPT_SUMMARY_PROMPT = (steering?: string) =>
  `You are summarising the earlier part of a conversation, so a model that continues it can answer without seeing every earlier message.

Write a single self-contained summary that preserves everything another model needs to continue the conversation faithfully:

- The overall intent and goal of the conversation, restated in one paragraph.
- The key decisions made and the facts established that later steps depend on — exact values, ids and names where they matter, never "some value was set".
- What files were read or written, and what tools were used, with enough of their findings to continue without re-running them.
- Any open threads, unanswered questions and pending approvals.
- The current state of the work at the point the summary ends.

Write in the language the conversation is mostly written in. The summary is read in place of the original messages, so it must stand alone: never refer to "the conversation above" or "earlier messages".

Length: concise, dense headings and bullet points where useful. Aim for no more than 600 words unless the conversation genuinely needs more.
${steering !== undefined ? `The requester's instruction for this summary: ${steering}` : ""}`;

/**
 * A summary pass's inputs, resolved by the caller — the model is a parameter,
 * never read inside (ADR-0041, so a cheaper summariser is a resolver change).
 */
export type TranscriptSummaryPassInput = {
  /** The Chat's id — the ordering, the deletion cascade and the in-flight
   *  registry all key on it. */
  chatId: string;
  /** The opened model — the Chat's own resolved model. */
  model: LanguageModel;
  /** The resolved model id to record in `stats`. */
  modelId: string;
  /** The full live path at trigger time, oldest first. */
  path: PlatypusUIMessage[];
  /** The occupancy reading the pass was triggered from. */
  triggeredFromOccupancy: number;
  /** The deepest usable summary already on the path — the incremental base. */
  previousSummary: ChatSummaryRow | undefined;
  /** The summary id the triggering reading was taken with, kept-tail rule. */
  readingSummaryId: string | undefined;
  /** The turn's clearable read-only tool names (MCP hints), if any. */
  readOnlyToolNames?: ReadonlySet<string>;
  /** The running turn's abort signal, when the pass runs inside a turn. */
  signal?: AbortSignal;
  /** A steering instruction for the summary — the User's, on `/compact`. */
  instruction?: string;
  /** Turns kept verbatim, when the caller decides rather than the reading
   *  (`/compact` keeps none). */
  keptTurns?: number;
  /** Injectable clock and summary id, for tests. */
  now?: () => Date;
  generateId?: () => string;
};

/**
 * Takes one Transcript summary: condenses the live path up to a new anchor
 * into a durable `chat_summary` row. NEVER fatal — every failure is logged and
 * produces no row, so the caller can proceed without one; the next pass
 * retries.
 *
 * The input is incremental: the previous usable summary plus the messages from
 * its anchor to the new one, so a pass costs roughly one window's worth of
 * input, never the whole Chat. Tool-result clearing is applied to every
 * clearable result in the input, unconditionally — the clearing that guards
 * ordinary turns at 0.7 does not gate a pass that may itself be the one
 * keeping a turn under the window.
 *
 * Overflow on the summary call retries once with an earlier anchor (one more
 * turn kept verbatim); a second failure is an ordinary failed summary. Summary
 * tokens fold into no turn's Token usage; `stats` records them from day one.
 */
export const takeTranscriptSummary = async (
  input: TranscriptSummaryPassInput,
): Promise<ChatSummaryRow | undefined> => {
  const {
    chatId,
    model,
    modelId,
    path,
    triggeredFromOccupancy,
    previousSummary,
    readingSummaryId,
    readOnlyToolNames,
    signal,
    instruction,
    keptTurns = transcriptSummaryKeptTurns(readingSummaryId),
    now = () => new Date(),
    generateId = defaultSummaryId,
  } = input;

  let anchorIndex = summaryAnchorIndex(path, keptTurns);
  if (anchorIndex === undefined) return undefined;

  // One bounded retry on a context overflow, with an earlier anchor — a pass
  // whose input alone outgrew the window it protects cannot be retried on the
  // same range. A second failure is an ordinary failed summary.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { priorText, messages } = incrementalInput(
      previousSummary,
      path,
      anchorIndex,
    );
    const modelMessages = await clearedModelMessages(
      messages,
      readOnlyToolNames,
    );

    try {
      const result = await generateText({
        model,
        // The summary is the conversation's first word in this call: the
        // model is handed the handoff, then the previous summary, then the
        // incremental range; it answers with the next summary.
        instructions: TRANSCRIPT_SUMMARY_PROMPT(instruction),
        messages: [
          ...(priorText !== undefined
            ? [
                {
                  role: "user" as const,
                  content: `[Summary so far]\n${priorText}`,
                },
              ]
            : []),
          ...modelMessages,
        ],
        maxOutputTokens: TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
        abortSignal: signal,
      });

      const anchor = path[anchorIndex];
      if (anchor === undefined) break;
      const anchorId = anchor.id;
      const row: ChatSummaryRow = {
        id: generateId(),
        chatId,
        anchorId,
        coveredIds: path.slice(0, anchorIndex + 1).map((message) => message.id),
        text: result.text,
        stats: {
          modelId,
          // A summary's usage is a measurement the pass's own call reported;
          // 0 stands in for a Provider that reported none (ADR-0018's rule).
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          triggeredFromOccupancy,
        },
        createdAt: now(),
      };
      try {
        await db.insert(chatSummary).values(row);
      } catch (error) {
        logger.error({ error, chatId }, "Error storing a transcript summary");
        return undefined;
      }
      logger.info(
        {
          chatId,
          anchorId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          trigger: triggeredFromOccupancy,
        },
        "Transcript summary taken",
      );
      return row;
    } catch (error) {
      if (isContextOverflowError(error) && attempt === 0) {
        const earlier = summaryAnchorIndex(path, keptTurns + 1);
        if (earlier === undefined || earlier >= anchorIndex) break;
        anchorIndex = earlier;
        logger.warn(
          { chatId, error },
          "Transcript summary call overflowed; retrying with an earlier anchor",
        );
        continue;
      }
      logger.warn(
        { chatId, error },
        "Transcript summary failed; proceeding without one",
      );
      return undefined;
    }
  }
  return undefined;
};

const defaultSummaryId = (): string => `sum_${randomUUID()}`;

/**
 * The incremental range as model messages, every clearable tool result in it
 * cleared unconditionally: converted once, like the turn's own pipeline
 * converts once, and cleared with a zero keep-recent so no clearable result
 * survives the pass — the pass must fit its own window, and re-clearing on the
 * way in costs nothing the clearing on the turn would not pay later anyway.
 */
export const clearedModelMessages = async (
  messages: PlatypusUIMessage[],
  readOnlyToolNames?: ReadonlySet<string>,
): Promise<ModelMessage[]> =>
  clearStaleToolResults(
    await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    // keepRecent 0: the pass's only limit is its own window, and every
    // clearable result in the range is older than the tail the pass protects.
    { thresholdFraction: 0, keepRecent: 0 },
    (toolName) => readOnlyToolNames?.has(toolName) ?? false,
  );

// --- The pass's model resolution && the in-flight registry ---

/** The Chat's own model reference a summary pass re-resolves (ADR-0017). */
export type SummariserSource =
  { agentId: string } | { providerId: string; modelId: string };

/**
 * Re-resolves the model a summary pass writes with, from the same authority a
 * Chat turn resolves its model from (`resolveGenerationPlan`) and with the
 * same "the reference, whichever form it was stored in" rule (ADR-0017). The
 * pass takes the opened model as a parameter; this is the caller's half of
 * that contract, shared by the turn finish and the backstop so they cannot
 * rewrite the rule in two places.
 */
export const resolveSummariserModel = async (
  source: SummariserSource,
  orgId: string,
  workspaceId: string,
  queries: TranscriptSummaryQueries,
): Promise<{
  model: LanguageModel;
  modelId: string;
  contextWindow?: number;
}> => {
  const generation: GenerationSource =
    "agentId" in source
      ? {
          // The agent row drives the same resolution a Chat turn gives the
          // same id, sampling fields included — an alias resolves again here
          // exactly as it would on the Chat's next turn (ADR-0017).
          agent: await mustGetAgent(
            source.agentId,
            orgId,
            workspaceId,
            queries,
          ),
        }
      : { providerId: source.providerId, modelId: source.modelId };
  const { plan, resolvedModelId } = await resolveGenerationPlan(
    generation,
    { orgId, workspaceId },
    queries,
  );
  return {
    model: plan.model,
    modelId: resolvedModelId,
    contextWindow: plan.contextWindow,
  };
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

/**
 * The in-flight summary passes on this instance, by Chat id. The registry is
 * what stops a backstop starting a second pass for a Chat whose finish-pass is
 * already running: the backstop awaits the same promise instead.
 *
 * Cross-instance, two instances could each hold a Chat's turn (the one-run
 * claim, #1253, prevents two RUNS, not a finish-pass racing another
 * instance's backstop); the immutable-row design makes the extra summary
 * harmless — several rows at one anchor are legal, and the newest usable one
 * wins at read time.
 */
const inFlightSummaries = new Map<
  string,
  Promise<ChatSummaryRow | undefined>
>();

/**
 * Starts the pass for `chatId` and registers it as the in-flight one; the
 * fire-and-forget caller that starts an after-turn pass, and any backstop that
 * joins it, share the promise.
 */
export const registerTranscriptSummary = (
  chatId: string,
  start: () => Promise<ChatSummaryRow | undefined>,
): Promise<ChatSummaryRow | undefined> => {
  const existing = inFlightSummaries.get(chatId);
  if (existing) return existing;

  // Registered BEFORE `start` runs, so a second caller reached from inside it
  // joins this entry instead of starting a second pass. `start` runs
  // synchronously here rather than on a later tick, for the same reason: a
  // backstop arriving a moment after an after-turn pass began must find it.
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
    // A `start` that throws synchronously rejects the pass rather than
    // throwing at the caller; a summary is never fatal.
    settled.reject(error);
  }
  return inFlight;
};

/**
 * The backstop: waits for a Transcript summary for `chatId`, starting one if
 * none is already in flight on this instance. A pass that is already being
 * taken is awaited, never duplicated.
 */
export const waitForTranscriptSummary = (
  chatId: string,
  start: () => Promise<ChatSummaryRow | undefined>,
): Promise<ChatSummaryRow | undefined> =>
  registerTranscriptSummary(chatId, start);

/**
 * `/compact` (issue #1111): takes a Transcript summary NOW, of the whole
 * Active path through its last turn, steered by the User's instruction. The
 * same pass the trigger and the backstop take — nothing kept verbatim, so the
 * next message the User sends is the first one the summary rides.
 *
 * A pass already in flight for the Chat (an after-turn one) is awaited first
 * rather than joined: it was taken without the User's instruction and keeps a
 * tail, so it is not what was asked for. Ours is registered, so a backstop
 * arriving meanwhile joins it.
 *
 * Resolves `undefined` when the pass fails; the summary is never fatal, but a
 * failed `/compact` is the caller's to report.
 */
export const compactTranscript = async (args: {
  chatId: string;
  orgId: string;
  workspaceId: string;
  /** The Chat's own model reference, as its last turn resolved it. */
  source: SummariserSource;
  path: PlatypusUIMessage[];
  instruction?: string;
}): Promise<ChatSummaryRow | undefined> => {
  const { chatId, orgId, workspaceId, source, path, instruction } = args;
  const anchorIndex = summaryAnchorIndex(path, 0);
  if (anchorIndex === undefined) return undefined;

  const claim = { ours: false };
  const start = async () => {
    claim.ours = true;
    const { model, modelId } = await resolveSummariserModel(
      source,
      orgId,
      workspaceId,
      drizzleTranscriptSummaryQueries,
    );
    return takeTranscriptSummary({
      chatId,
      model,
      modelId,
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
  // `start` runs synchronously up to its first await, so `claim` is settled
  // by the time `registerTranscriptSummary` returns.
  const first = registerTranscriptSummary(chatId, start);
  if (claim.ours) return first;
  await first.catch(() => undefined);
  return registerTranscriptSummary(chatId, start);
};
