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
  maxOutputTokensForModel,
  pointerSettingModelId,
} from "./model-capability.ts";
import { jobCallSettings, jobMaxOutputTokens } from "./reasoning.ts";
import { jobInputBudgetChars } from "./job-input-budget.ts";
import {
  resolveTaskModelProvider,
  type TaskModelWorkspace,
} from "./task-model.ts";
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
  /** Only the Workspace field task-model selection reads. */
  getWorkspace(
    orgId: string,
    workspaceId: string,
  ): Promise<TaskModelWorkspace | null>;
};

import type { ProviderRow } from "./provider-write.ts";

/**
 * The production `TranscriptSummaryQueries`: Scoped-resource reads, exactly as
 * a Chat turn serves them (ADR-0007), so a Shared (org-scoped) Provider/Agent
 * resolves for a summary pass the way it resolved the turn.
 */
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

/**
 * The live `agent` row a generation plan re-resolves from, stated minimally
 * (a SamplingSource satisfies the rest of `GenerationSource`'s agent shape).
 * Production passes the real `agent` table row; tests pass a fixture.
 */
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
 * The structured handoff a Transcript summary is written from (issue #2015):
 * eight required sections under fixed English headings, so the User's own
 * requests and the content of what was produced survive, done work stays
 * apart from planned work, and a reader can find each section in any
 * language. It explains the pass's own input — the leading `[Summary so far]`,
 * cleared tool results, and the closing `TRANSCRIPT_SUMMARY_REQUEST` — and
 * scales its length to the input. An optional steering instruction (the
 * User's, from `/compact`) tells the pass what to keep.
 */
const TRANSCRIPT_SUMMARY_PROMPT = (steering?: string) =>
  `You are writing the handoff summary of the earlier part of a conversation. A model that continues the conversation reads your summary instead of those messages, so anything you leave out is lost for good.

If the input begins with "[Summary so far]", that is the summary of the part before it. Merge it into your new summary. The newer messages take precedence: update or remove an item they resolved, superseded or made stale. Never drop something only because it came from the earlier summary. A user request carried in from the earlier summary that was fully answered may be shortened to the instructions, constraints and preferences it set.

Search results and pages that were read may appear only as cleared placeholders. Rely on what the assistant's replies concluded from them, and never present a result you cannot see as fact.

The final message, which asks you to write the summary, is the instruction for this task, not part of the conversation. Leave it out of every section.

Before you write, go through the conversation in order and note every user request, every answer that produced something, every tool finding and every decision. Do not include these notes in the summary.

Then write the summary under exactly these headings, in this order, starting directly with the first heading. Write "None." under a heading that has nothing to report.

## Intent
One paragraph: what the user is trying to achieve overall and why, including who they are or which organisation they represent where that was established.

## User requests
Requests carried in from the earlier summary come first. Then count the user messages in the conversation itself, leaving out the "[Summary so far]" message and the final message that asks for this summary; each one gets its own bullet, short follow-ups included. Copy each of them verbatim, in its original language, in order, one bullet each. Shorten only a message longer than about 300 characters, keeping every instruction, constraint, preference and correction (language, format, audience, deadlines, "not X but Y"). The number of these bullets must equal the number of user messages you counted. End each bullet with whether it was fully answered.

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

/**
 * The user message that closes the pass's input. The range always ends with
 * the anchor, an assistant message, and a chat model handed a trailing
 * assistant message continues it (DeepSeek's prefix completion, and most
 * OpenAI-compatible templates) rather than reading the instructions — one
 * /compact stored a single space, the next stored the reply's continuation.
 * Ending on a user turn is what makes the model answer the instructions.
 */
export const TRANSCRIPT_SUMMARY_REQUEST =
  "Write the summary now, following the instructions you were given.";

/** One opened model a summary pass may write with, and the id to record in
 *  `stats` when it does. */
export type TranscriptSummaryModel = {
  model: LanguageModel;
  modelId: string;
  /** The task model's Job settings as call options (ADR-0045). The Chat's
   *  own model carries them only when it is the task model. */
  settings?: ReturnType<typeof jobCallSettings>;
  /** The output cap raised by the Job settings' Thinking budget; absent, the
   *  pass's own cap. */
  maxOutputTokens?: number;
  /** The output ceiling declared on the model's entry. A summary call never
   *  asks for more, since a vendor rejects a cap above the model's own. */
  outputCeiling?: number;
  /** The task model's declared context window, which a pass checks its input
   *  against before calling; absent, the model's own error is the measure. */
  contextWindow?: number;
};

/** The models a pass tries: the Chat's own model, and the task model first
 *  where it differs from the Chat's. */
export type TranscriptSummaryModels = {
  chat: TranscriptSummaryModel;
  task?: TranscriptSummaryModel;
};

/**
 * A summary pass's inputs, resolved by the caller — the models are parameters,
 * never read inside (ADR-0041, so a cheaper summariser is a resolver change).
 *
 * The pass tries `task` first where present and falls back to `chat`, so every
 * caller gets the same order.
 */
export type TranscriptSummaryPassInput = {
  /** The Chat's id — the ordering, the deletion cascade and the in-flight
   *  registry all key on it. */
  chatId: string;
  /** The models to try: the task model first where present, then the Chat's. */
  models: TranscriptSummaryModels;
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
 * The pass tries the task model first where the caller supplied one, falling
 * back to the Chat's own model on any failure — a context overflow, an
 * unknown model, an auth error, or a blank or cut-off reply. Where the task
 * model declares a context window, an input over the job budget of it skips the
 * task model outright: a server that truncates an overlong prompt instead of
 * rejecting it would otherwise write a summary of a cut-off conversation, and
 * no error would trigger the fallback. A summary cannot be trimmed to fit the
 * way memory extraction trims its input, because every covered message is
 * replaced by it. Without a declared window, the model's own error is the
 * only measurement available.
 *
 * Overflow on the Chat's model retries once with an earlier anchor (one more
 * turn kept verbatim); a second failure is an ordinary failed summary. A
 * model fallback is its own step beside that anchor retry, so a pass makes at
 * most three model calls. Summary tokens fold into no turn's Token usage;
 * `stats` records the model that actually wrote it and the counts from day one.
 */
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
    now = () => new Date(),
    generateId = defaultSummaryId,
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
        // The summary is the conversation's first word in this call: the
        // model is handed the handoff, then the previous summary, then the
        // incremental range; it answers with the next summary.
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
        maxOutputTokens: Math.min(
          entry.maxOutputTokens ?? TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
          entry.outputCeiling ?? Infinity,
        ),
        abortSignal: signal,
      });

      // A blank reply, or one cut off at the output cap, is a failed summary,
      // not a summary: stored, it would stand in for every covered message
      // and the next turn would read nothing, or a summary ending
      // mid-sentence. A task model that answers so falls back like any other
      // task-model failure.
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
        id: generateId(),
        chatId,
        anchorId,
        coveredIds: path
          .slice(0, input.anchorIndex + 1)
          .map((message) => message.id),
        text: result.text,
        stats: {
          modelId: entry.modelId,
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

  // Characters ÷ 4 over the serialised messages over-counts (keys, escaping,
  // inline file data), so a misjudged input is one the Chat's model writes —
  // the behaviour before a task model existed — never a summary lost.
  const fitsDeclaredWindow = (
    entry: TranscriptSummaryModel,
    input: SummaryInput,
  ): boolean =>
    entry.contextWindow === undefined ||
    TRANSCRIPT_SUMMARY_PROMPT(instruction).length +
      (input.priorText?.length ?? 0) +
      JSON.stringify(input.modelMessages).length +
      TRANSCRIPT_SUMMARY_REQUEST.length <=
      jobInputBudgetChars(entry.contextWindow);

  let summaryInput = await anchorInput(anchorIndex);

  if (taskModel && !fitsDeclaredWindow(taskModel, summaryInput)) {
    logger.info(
      {
        chatId,
        modelId: taskModel.modelId,
        contextWindow: taskModel.contextWindow,
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

  // The Chat's model keeps the existing overflow ladder: one retry with an
  // earlier anchor. It is not preceded by another task-model attempt, which
  // is what bounds a pass at three model calls.
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

/**
 * The incremental range as model messages, every clearable tool result in it
 * cleared unconditionally: converted once, like the turn's own pipeline
 * converts once, and cleared with a zero keep-recent so no clearable result
 * survives the pass — the pass must fit its own window, and re-clearing on the
 * way in costs nothing the clearing on the turn would not pay later anyway.
 */
const clearedModelMessages = async (
  messages: PlatypusUIMessage[],
  readOnlyToolNames?: ReadonlySet<string>,
): Promise<ModelMessage[]> =>
  clearStaleToolResults(
    await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    // keepRecent 0: the pass's only limit is its own window, and every
    // clearable result in the range is older than the tail the pass protects.
    // `clearingPrefixLength` clears all of them for keepRecent 0; the batch size
    // is irrelevant there.
    { keepRecent: 0, batchSize: TOOL_CLEARING_BATCH },
    (toolName) => readOnlyToolNames?.has(toolName) ?? false,
  );

// --- The pass's model resolution && the in-flight registry ---

/** The Chat's own model reference a summary pass re-resolves (ADR-0017). */
export type SummariserSource =
  { agentId: string } | { providerId: string; modelId: string };

/**
 * Re-resolves the models a summary pass tries, in order: the Workspace's task
 * model first where it differs, then the Chat's own model. The Chat's model
 * comes from the same authority a Chat turn resolves its model from
 * (`resolveGenerationPlan`) and with the same "the reference, whichever form it
 * was stored in" rule (ADR-0017).
 *
 * The pass takes the opened models as a parameter; this is the caller's half
 * of that contract, shared by the turn finish, `/compact` and the backstop so
 * they cannot rewrite the rule in two places.
 */
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

/**
 * The Chat's model with the task model in front of it, where there is one to
 * try. There is none for a Provider this Workspace cannot see, or an empty
 * Task Model ID. A task model that IS the Chat's model is not tried twice:
 * the Chat's entry carries its Job settings (ADR-0045), so the pass makes one
 * call and keeps its overflow ladder. Resolution never makes the pass fail —
 * an unavailable task model just means the Chat's model writes the summary.
 */
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
    // An empty Task Model ID is a Provider with no task model configured, not
    // a model to call: the form allows it, and every call would be doomed.
    if (taskModelId.trim() === "") return { chat };
    const settings = jobCallSettings(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
      taskProvider.provider.taskModelSettings,
    );
    const maxOutputTokens = jobMaxOutputTokens(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
      taskProvider.provider.taskModelSettings,
      TRANSCRIPT_SUMMARY_MAX_OUTPUT_TOKENS,
    );
    if (
      taskProvider.provider.id === chatProviderId &&
      taskModelId === chat.modelId
    ) {
      return { chat: { ...chat, settings, maxOutputTokens } };
    }
    const contextWindow = contextWindowForModel(
      taskProvider.provider,
      pointerSettingModelId(taskModelId),
    );
    const outputCeiling = maxOutputTokensForModel(
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
        ...(outputCeiling !== undefined ? { outputCeiling } : {}),
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
 * The one take the turn verbs start: the anchor, the incremental base and the
 * occupancy the pass records are derived here once, so the backstop and the
 * after-turn pass cannot drift. The caller supplies the models to try (already
 * resolved for the backstop, freshly resolved for the finish) and the summaries
 * it read.
 */
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

// --- The two turn verbs a caller uses ---

/**
 * What a Chat turn asks before the model is called: apply the deepest usable
 * Transcript summary, and — where the pre-turn backstop is due and a Chat id is
 * known — wait for (or join) a take and apply its result. A Trigger run has no
 * Chat id: it applies only, never takes (ADR-0041).
 *
 * The turn's own resolved model and signal are passed in, so the backstop
 * falls back to the model the turn already opened rather than re-resolving the
 * Chat's model (unlike {@link afterTurn}). It does resolve the Workspace's task
 * model to try first, and is cancellable with the turn that is waiting on it.
 */
export const beforeTurn = async (args: {
  /** The Chat's id; absent on a Trigger run, which never takes a summary. */
  chatId?: string;
  /** The stored Transcript, oldest first. */
  path: PlatypusUIMessage[];
  /** The Chat's summaries, already loaded by the caller. */
  summaries: ChatSummaryRow[];
  contextWindow?: number;
  model: LanguageModel;
  modelId: string;
  /** The output ceiling declared on the turn's model, if any. */
  maxOutputTokens?: number;
  /** Present on a Chat turn: where the task model is resolved from. */
  taskModel?: {
    scope: ScopeContext;
    /** The Chat's own Provider id — the task-model fallback. */
    providerId: string;
  };
  readOnlyToolNames?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<{
  messages: PlatypusUIMessage[];
  summaryId?: string;
  /** Whether the backstop waited for and applied a freshly taken summary. */
  backstopEngaged: boolean;
}> => {
  const {
    chatId,
    path,
    contextWindow,
    model,
    modelId,
    maxOutputTokens,
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
      ...(maxOutputTokens !== undefined
        ? { outputCeiling: maxOutputTokens }
        : {}),
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

/**
 * The after-turn pass: fire-and-forget, never throws. Decides due-ness from the
 * turn's final reading (or an overflowed reply, issue #1717) and registers the
 * take so a next turn's backstop joins it rather than starting a second.
 *
 * Unlike the backstop, this re-resolves the model from `source` — the same
 * authority the turn resolved it from (ADR-0017) — because the turn that just
 * finished is no longer holding its plan open.
 */
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
  // A reply the Provider rejected as too long (issue #1717) is due whatever
  // the reading or the window: the rejection is the measurement. Taken now
  // rather than only at the next turn's backstop, so a regenerate — whose
  // path no longer holds this reply — still finds the summary waiting.
  const overflowed = overflowedReply(path);
  if (
    !overflowed &&
    !transcriptSummaryDueAfterTurn(reading?.projected, contextWindow)
  ) {
    return;
  }
  // The summary the shrinking tail is measured against: the one the
  // overflowed reply ran with, or the one the triggering reading did.
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
    // `takeTranscriptSummary` never throws by itself; this is the model
    // re-resolution's failure (an Agent or Provider deleted mid-flight) and
    // the occasional join of a backstop's pass. Never fatal either way.
    logger.error(
      { error, chatId },
      "After-turn transcript summary failed; the next turn's finish retries",
    );
  });
};

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
  // `start` runs synchronously up to its first await, so `claim` is settled
  // by the time `registerTranscriptSummary` returns.
  const first = registerTranscriptSummary(chatId, start);
  if (claim.ours) return first;
  await first.catch(() => undefined);
  return registerTranscriptSummary(chatId, start);
};
