import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { isContextOverflowError } from "./context-overflow.ts";

/** An `APICallError` as a Provider package throws it for a rejected request. */
const rejection = (statusCode: number, message: string, responseBody: string) =>
  new APICallError({
    message,
    url: "https://provider.example/v1",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });

/**
 * Each phrasing as the vendor sends it — the error body the Provider returns
 * for an over-long request, and the message its SDK package derives from it.
 */
const OVERFLOWS = {
  openai: rejection(
    400,
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens. Please reduce the length of the messages.",
    '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens. Please reduce the length of the messages.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
  ),
  vllm: rejection(
    400,
    "This model's maximum context length is 32768 tokens. However, you requested 40960 tokens (39936 in the messages, 1024 in the completion). Please reduce the length of the messages or completion.",
    '{"object":"error","message":"This model\'s maximum context length is 32768 tokens. However, you requested 40960 tokens (39936 in the messages, 1024 in the completion). Please reduce the length of the messages or completion.","type":"BadRequestError","param":null,"code":400}',
  ),
  anthropic: rejection(
    400,
    "prompt is too long: 208310 tokens > 200000 maximum",
    '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 208310 tokens > 200000 maximum"}}',
  ),
  google: rejection(
    400,
    "The input token count (1196341) exceeds the maximum number of tokens allowed (1048576).",
    '{"error":{"code":400,"message":"The input token count (1196341) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}',
  ),
  bedrock: rejection(
    400,
    "Input is too long for requested model.",
    '{"message":"Input is too long for requested model."}',
  ),
};

describe("isContextOverflowError", () => {
  it.each(Object.entries(OVERFLOWS))(
    "detects the %s overflow rejection",
    (_vendor, error) => {
      expect(isContextOverflowError(error)).toBe(true);
    },
  );

  it("does not take an invalid tool schema 400 for an overflow", () => {
    const error = rejection(
      400,
      "Invalid schema for function 'searchDocs': In context=(), 'required' is required to be supplied and to be an array including every key in properties.",
      '{"error":{"message":"Invalid schema for function \'searchDocs\'","type":"invalid_request_error","param":"tools[0].function.parameters","code":"invalid_function_parameters"}}',
    );
    expect(isContextOverflowError(error)).toBe(false);
  });

  it("does not take a broad 'too many tokens' or request_too_large for one", () => {
    expect(
      isContextOverflowError(
        rejection(413, "Request too large", '{"type":"request_too_large"}'),
      ),
    ).toBe(false);
    expect(
      isContextOverflowError(rejection(400, "too many tokens in batch", "")),
    ).toBe(false);
  });

  it("ignores an overflow phrasing on a non-request status, or a non-API error", () => {
    expect(
      isContextOverflowError(
        rejection(500, "maximum context length exceeded", ""),
      ),
    ).toBe(false);
    expect(
      isContextOverflowError(new Error("prompt is too long: 9 > 8 maximum")),
    ).toBe(false);
  });
});
