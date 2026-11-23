import type { LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";

export const MOVED_FILE_PLACEHOLDER =
  "(file attached in the following user message)";

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
    if (prompt[i + 1]?.role !== "tool") {
      if (moved.length > 0) out.push({ role: "user", content: moved });
      moved = [];
      callNumber = 0;
    }
  });
  return out;
};

export const toolResultFilesMiddleware: LanguageModelMiddleware = {
  transformParams: ({ params }) =>
    Promise.resolve({ ...params, prompt: moveToolResultFiles(params.prompt) }),
};
