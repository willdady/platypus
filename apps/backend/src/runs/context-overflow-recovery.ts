import type { LanguageModelMiddleware, TextStreamPart, ToolSet } from "ai";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { logger } from "../logger.ts";
import { isContextOverflowError } from "../services/context-overflow.ts";

export const TOOL_RESULT_TOO_LARGE =
  "This result was too large to fit the model's context. Request less: a narrower query, a smaller page, or a range.";

type ReplacedCall = { toolCallId: string; toolName: string; input: unknown };

export type OverflowRecovery = {
  middleware: LanguageModelMiddleware;
  injectToolErrors: <TOOLS extends ToolSet>(
    stream: ReadableStream<TextStreamPart<TOOLS>>,
  ) => ReadableStream<TextStreamPart<TOOLS>>;
};

export const createOverflowRecovery = (): OverflowRecovery => {
  const replaced = new Set<string>();
  const pending: ReplacedCall[] = [];

  // why: the SDK re-sends real results on later calls; a replaced one must stay replaced
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
        // why: transformParams already ran, and the one retry must not re-enter this catch
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
