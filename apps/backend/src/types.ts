import { type UIMessage, type InferUITool, type UIDataTypes } from "ai";
import { createLoadSkillTool } from "./tools/skill.ts";
import type { DelegateTool } from "./tools/sub-agent.ts";

/**
 * Metadata the run pipeline attaches to a streamed assistant message.
 *
 * Every field is optional and each is emitted on its own stream chunk: the
 * client merges metadata chunks into the message rather than replacing it, so
 * a run that resolves no agent but ends truncated still carries the truncation
 * flag, and a truncated agent run keeps its attribution.
 *
 * A key that does not apply is absent rather than `false`, so a message's
 * metadata says only what is true of it. `contextOccupancy` is the one
 * departure: it is written as a concrete `null` where an earlier reading has to
 * be erased, because the merge that makes the above work skips `undefined`.
 */
export type ChatMessageMetadata = {
  /** Agent the run resolved; the chat UI renders its name and avatar. */
  agentId?: string;
  /**
   * The turn's terminal finish hit the model's output token ceiling, so the
   * answer stops mid-thought. The chat marks the message as cut short.
   */
  truncatedByTokenLimit?: true;
  /**
   * The turn's model loop was stopped because it reached its **Step ceiling**,
   * with the model still asking to continue — so the reply is whatever it had
   * produced by then, often a tool card and no answer at all. The chat marks
   * the message as cut short.
   *
   * The sibling of `truncatedByTokenLimit`, and never both: one bounds the loop
   * and the other bounds a single reply, and the terminal finish reason names
   * only one of them.
   */
  stoppedAtStepLimit?: true;
  /**
   * Search was requested for this turn and Turn resolution served no search
   * tools, so the reply was written without it — the **Unavailable capability**
   * of `CONTEXT.md`. The model was not told; the Chat renders a notice under the
   * reply.
   *
   * Outcome-based, not cause-based: it covers an unregistered backend id, and a
   * backend whose `createExecutors` threw, outran its timeout, or returned no
   * `web_search` executor. An empty native tool set is covered by the same
   * check but cannot currently arise — every provider type that passes
   * `providerHasNativeSearch` returns a tool — so a `true` here always names a
   * Web-search backend today.
   *
   * A `searchSource` that *resolves* to no search never sets this: nothing was
   * promised, so nothing was missing. `"native"` on a Provider with no native tool
   * is that case, not the defensive one above — it resolves to the none-kind
   * long before any tool set is built.
   *
   * Known before the model is called, so it is emitted on `start`, not derived
   * from a `finish` part.
   */
  searchUnavailable?: true;
  /**
   * How long each of the turn's locally-executed tools took, in whole
   * milliseconds, keyed by `toolCallId`.
   *
   * A delivery channel, not the record: the same figures are stamped onto the
   * tool parts themselves (`toolMetadata.durationMs`), which is what a reload
   * reads and what every message persisted so far carries. They live here as
   * well because the UI message stream's tool reducer discards metadata an
   * output chunk carries, leaving message metadata as the only seam that
   * reaches the browser mid-turn (issue #353).
   *
   * Absent for a turn that ran no local tools. A single call is absent where the
   * Provider executed it in its own service, which Platypus never measures.
   */
  toolDurations?: Record<string, number>;
  /**
   * How full the model's Context window was when this message was produced
   * (ADR-0018): the input-token count the Provider reported for the **last**
   * model call of the turn — inclusive of cached reads and writes, so the true
   * size of what was sent — plus that same call's output tokens, which makes
   * the next turn's starting size derivable exactly.
   *
   * A last value, never a sum: the conversation is re-sent in full on every
   * turn, so occupancy replaces rather than accumulates. Absent where the
   * Provider reported no usage — occupancy is then unknown and nothing is
   * estimated. `null` where a Provider reported a count for an earlier call of
   * the turn but not for the last one, which makes the earlier figure stale
   * rather than current.
   *
   * Absent and `null` say the same thing to a reader — occupancy is unknown,
   * show nothing — and differ only in why. Normalise with `?? null` at the read
   * site rather than branching on both.
   */
  contextOccupancy?: {
    /** The occupancy figure itself. */
    inputTokens: number;
    /**
     * `null` rather than absent when the Provider reported an input count and
     * no output one, because metadata chunks are deep-merged: an omitted key
     * would leave an earlier step's output figure looking current.
     */
    outputTokens: number | null;
  } | null;
  /**
   * The turn's billed Token usage (`CONTEXT.md`): the vendor's reported input
   * and output counts folded across every model call the turn made. A sum,
   * legitimately, because each call is billed separately — distinct from
   * `contextOccupancy`, which is a last value and means something else
   * entirely (issue #354).
   *
   * Absent where the Provider reported no usage on any step of the turn;
   * nothing is estimated. Never needs erasing: unlike occupancy, it only ever
   * grows as the turn's steps report in, so a later step cannot make it stale.
   */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /**
   * How long Turn resolution took, in whole milliseconds, before the model
   * request was sent. Surfaced to Users as **Preparation** (`CONTEXT.md`).
   *
   * Known before the stream exists — Turn resolution has already finished by
   * the time this message starts — so it rides `start` the same way `agentId`
   * does, and survives a turn cancelled before any model content arrives.
   */
  prepDurationMs?: number;
  /**
   * How long the Drive ran, in whole milliseconds, from the model request
   * being sent to the moment this reading was taken. Surfaced to Users as
   * **Model** (`CONTEXT.md`); tool execution happens inside this phase and is
   * reported separately, nested, from `toolDurations`.
   *
   * Emitted per step, last one standing, for the same reason `contextOccupancy`
   * is: the terminal `finish` part never arrives on an aborted run, and a
   * cancelled turn is exactly when someone wants to know how long it ran.
   */
  modelDurationMs?: number;
};

/**
 * Tools whose input/output shapes are consumed by bespoke chat UI.
 *
 * Deliberately not the whole tool surface, and it cannot be one: the native
 * tool sets are plugins loaded at runtime (ADR-0013), third-party plugins
 * contribute tools under namespaced contribution ids, and MCP tools are
 * unknown until connect time. Add an entry only when a component needs that
 * tool's typed input or output — every other tool renders through the generic
 * `ToolUIPart` path.
 *
 * `delegate` earns its place because the Sub-Agent card reads the target's name
 * off the tool's input. Chats that predate the single dispatcher still hold
 * parts named `tool-delegateTo<Name>`, which no static key can cover — the
 * renderer keeps matching those by prefix, in addition to this one.
 */
export type CustomUITools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
  delegate: InferUITool<DelegateTool>;
};

export type PlatypusUIMessage = UIMessage<
  ChatMessageMetadata,
  UIDataTypes,
  CustomUITools
>;
