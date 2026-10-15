import type { LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";

/** What a file in a tool result is replaced with, in the tool message itself. */
export const MOVED_FILE_PLACEHOLDER =
  "(file attached in the following user message)";

/**
 * Move the files in tool results into a `user` message after them (ADR-0038).
 *
 * Some Provider adapters cannot carry a file inside a tool result: the
 * OpenAI-compatible one JSON-stringifies it, so the model reads base64 and
 * makes up a description. Every one of them carries files in a `user` message.
 * So each file part in a tool result becomes placeholder text, and one `user`
 * message after the **last** `tool` message of a run holds those files in call
 * order, each labelled with its tool and call so the model can match them up.
 * Never between two tool results of one assistant turn: a strict
 * OpenAI-compatible API rejects that.
 *
 * Works on the typed prompt, before the Provider's converter runs, so each
 * converter renders the `user` message in its own format. A prompt with no
 * file in a tool result is returned as is.
 */
export const moveToolResultFiles = (
  prompt: LanguageModelV4Prompt,
): LanguageModelV4Prompt => {
  const hasFile = prompt.some(
    (m) =>
      m.role === "tool" &&
      m.content.some(
        (p) =>
          p.type === "tool-result" &&
          p.output.type === "content" &&
          p.output.value.some((v) => v.type === "file"),
      ),
  );
  if (!hasFile) return prompt;

  const out: LanguageModelV4Message[] = [];
  let moved: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> = [];
  let callNumber = 0;

  prompt.forEach((message, i) => {
    if (message.role !== "tool") {
      out.push(message);
      return;
    }
    out.push({
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        callNumber++;
        if (part.output.type !== "content") return part;
        return {
          ...part,
          output: {
            ...part.output,
            value: part.output.value.map((value) => {
              if (value.type !== "file") return value;
              moved.push(
                {
                  type: "text",
                  text: `File from tool result \`${part.toolName}\` (call ${callNumber}): \`${value.filename ?? "file"}\``,
                },
                {
                  type: "file",
                  data: value.data,
                  mediaType: value.mediaType,
                  ...(value.filename ? { filename: value.filename } : {}),
                },
              );
              return { type: "text" as const, text: MOVED_FILE_PLACEHOLDER };
            }),
          },
        };
      }),
    });
    // The run ends here: close it with the files it carried.
    if (prompt[i + 1]?.role !== "tool") {
      if (moved.length > 0) out.push({ role: "user", content: moved });
      moved = [];
      callNumber = 0;
    }
  });
  return out;
};

/** {@link moveToolResultFiles} as a language-model middleware. */
export const toolResultFilesMiddleware: LanguageModelMiddleware = {
  transformParams: ({ params }) =>
    Promise.resolve({ ...params, prompt: moveToolResultFiles(params.prompt) }),
};
