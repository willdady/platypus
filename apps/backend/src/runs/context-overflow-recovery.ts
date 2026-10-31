import type { LanguageModelMiddleware, TextStreamPart, ToolSet } from "ai";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { logger } from "../logger.ts";
import { isContextOverflowError } from "../services/context-overflow.ts";

/**
 * Context-overflow recovery inside one model loop (issue #1717, R3).
 *
 * When a model call overflows the context and the step before it was a tool
 * step, that step's tool results are what grew the request past the window.
 * They are replaced with a tool error telling the model to ask for less, and
 * the call is retried ONCE. A second overflow falls through to the Drive's
 * error path, which tells the User the conversation is too long (R1).
 *
 * **At most one retry per step, whichever strategy takes it** (ADR-0041): this
 * middleware's catch is the one seam a later in-call trim (R2) plugs into, as
 * another strategy inside the same single retry — never a second one.
 */

/** What a replaced tool result becomes — for the model and the stored Transcript alike. */
export const TOOL_RESULT_TOO_LARGE =
  "This result was too large to fit the model's context. Request less: a narrower query, a smaller page, or a range.";

/** A replaced call, as the run's stream reports it. */
type ReplacedCall = { toolCallId: string; toolName: string; input: unknown };

export type OverflowRecovery = {
  /** Wraps every model call of the loop — see `buildModelInvocation`. */
  middleware: LanguageModelMiddleware;
  /**
   * Puts each replaced result on the run's stream as a `tool-error` for that
   * call, so the client, the fold the Chat persists and Run events all hold
   * the tool error as the call's result — replacing the result already
   * streamed. The stored Transcript is then re-sendable as it stands.
   */
  injectToolErrors: <TOOLS extends ToolSet>(
    stream: ReadableStream<TextStreamPart<TOOLS>>,
  ) => ReadableStream<TextStreamPart<TOOLS>>;
};

/** One recovery per model loop: the replaced calls are this loop's state. */
export const createOverflowRecovery = (): OverflowRecovery => {
  const replaced = new Set<string>();
  const pending: ReplacedCall[] = [];

  // Applied to every later call of the loop too: the SDK re-sends the step's
  // real results, and a replaced result has to stay replaced.
  const withReplaced = (prompt: LanguageModelV4Prompt): LanguageModelV4Prompt =>
    prompt.map((message) =>
      message.role !== "tool"
        ? message
        : {
            ...message,
            content: message.content.map((part) =>
              part.type === "tool-result" && replaced.has(part.toolCallId)
                ? {
                    ...part,
                    output: {
                      type: "error-text" as const,
                      value: TOOL_RESULT_TOO_LARGE,
                    },
                  }
                : part,
            ),
          },
    );

  const middleware: LanguageModelMiddleware = {
    transformParams: ({ params }) =>
      Promise.resolve(
        replaced.size > 0
          ? { ...params, prompt: withReplaced(params.prompt) }
          : params,
      ),
    wrapStream: async ({ doStream, params, model }) => {
      try {
        return await doStream();
      } catch (error) {
        const last = params.prompt.at(-1);
        if (!isContextOverflowError(error) || last?.role !== "tool") {
          throw error;
        }
        const results = last.content.filter(
          (part) => part.type === "tool-result",
        );
        // Nothing new to replace: this step already took its one retry, and
        // the SDK's backoff is re-sending it. Fall through to R1.
        if (results.every((part) => replaced.has(part.toolCallId))) {
          throw error;
        }

        const inputs = new Map(
          params.prompt
            .flatMap((message) =>
              message.role === "assistant" ? message.content : [],
            )
            .filter((part) => part.type === "tool-call")
            .map((part) => [part.toolCallId, part.input]),
        );
        for (const { toolCallId, toolName } of results) {
          replaced.add(toolCallId);
          pending.push({ toolCallId, toolName, input: inputs.get(toolCallId) });
        }
        logger.warn(
          { toolCallIds: results.map((part) => part.toolCallId) },
          "Model call overflowed after a tool step; retrying once with the tool results replaced",
        );
        // The retry calls the model directly: `transformParams` already ran
        // for this call, and the one retry must not pass back through here.
        return model.doStream({
          ...params,
          prompt: withReplaced(params.prompt),
        });
      }
    },
  };

  const injectToolErrors = <TOOLS extends ToolSet>(
    stream: ReadableStream<TextStreamPart<TOOLS>>,
  ) => {
    const drain = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
    ) => {
      for (const call of pending.splice(0)) {
        controller.enqueue({
          type: "tool-error",
          ...call,
          error: TOOL_RESULT_TOO_LARGE,
          dynamic: true,
        });
      }
    };
    return stream.pipeThrough(
      new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
        transform(part, controller) {
          drain(controller);
          controller.enqueue(part);
        },
        flush: drain,
      }),
    );
  };

  return { middleware, injectToolErrors };
};
