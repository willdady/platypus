import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FileUIPart, UIMessage } from "ai";
import { useMessageEditing } from "./use-message-editing";

/**
 * Editing used to resubmit `{ text }` and nothing else, so a message that
 * carried a file came back without it — the model answered a different
 * question and nothing on screen said why (issue #710). These tests pin the
 * round trip at the hook: what an edit opens holding, and what it resubmits.
 */

const report: FileUIPart = {
  type: "file",
  url: "https://files.example.com/report.pdf",
  mediaType: "application/pdf",
  filename: "report.pdf",
};

const screenshot: FileUIPart = {
  type: "file",
  url: "https://files.example.com/shot.png",
  mediaType: "image/png",
  filename: "shot.png",
};

const transcript: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [report, screenshot, { type: "text", text: "What does this say?" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "It says X." }],
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "And this?" }] },
];

const harness = (messages: UIMessage[] = transcript) => {
  const setMessages = vi.fn();
  const sendMessage = vi.fn();
  const getRequestBody = vi.fn().mockReturnValue({ providerId: "p1" });
  const view = renderHook(() =>
    useMessageEditing(messages, setMessages, sendMessage, getRequestBody),
  );
  return { ...view, setMessages, sendMessage, getRequestBody };
};

describe("useMessageEditing opening an edit", () => {
  it("edits nothing until a message is named", () => {
    const { result } = harness();

    expect(result.current.editing).toBeNull();
  });

  it("opens holding the message's text and every file it carries", () => {
    const { result } = harness();

    act(() => result.current.handleMessageEditStart("u1"));

    expect(result.current.editing).toEqual({
      messageId: "u1",
      text: "What does this say?",
      attachments: [report, screenshot],
    });
  });

  it("joins a message written across several text parts", () => {
    const { result } = harness([
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "First half. " },
          { type: "text", text: "Second half." },
        ],
      },
    ]);

    act(() => result.current.handleMessageEditStart("u1"));

    expect(result.current.editing?.text).toBe("First half. Second half.");
  });

  it("closes on cancel without touching the transcript", () => {
    const { result, setMessages, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() => result.current.handleMessageEditCancel());

    expect(result.current.editing).toBeNull();
    expect(setMessages).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("useMessageEditing submitting an edit", () => {
  it("resubmits the attachments the edit surface hands back", () => {
    const { result, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({
        text: "What does this actually say?",
        files: [report, screenshot],
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      {
        text: "What does this actually say?",
        files: [report, screenshot],
      },
      { body: { providerId: "p1" } },
    );
  });

  it("truncates the transcript at the edited message and closes", () => {
    const { result, setMessages } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(setMessages).toHaveBeenCalledWith([]);
    expect(result.current.editing).toBeNull();
  });

  it("truncates at a message part-way down the transcript", () => {
    const { result, setMessages } = harness();

    act(() => result.current.handleMessageEditStart("u2"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(setMessages).toHaveBeenCalledWith([transcript[0], transcript[1]]);
  });

  it("sends attachments the user added while editing", () => {
    const added: FileUIPart = {
      type: "file",
      url: "data:text/plain;base64,aGk=",
      mediaType: "text/plain",
      filename: "extra.txt",
    };
    const { result, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({
        text: "Both, please",
        files: [report, added],
      }),
    );

    expect(sendMessage.mock.calls[0][0].files).toEqual([report, added]);
  });

  // An attachment-only edit is a real edit: the question was the file.
  it("stands in a text for an edit left with attachments and no words", () => {
    const { result, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "", files: [report] }),
    );

    expect(sendMessage.mock.calls[0][0]).toEqual({
      text: "Sent with attachments",
      files: [report],
    });
  });

  // Truncating the transcript and sending nothing is how a stray Enter would
  // wipe a conversation with no way back.
  it("refuses an edit with neither text nor attachments", () => {
    const { result, setMessages, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() => result.current.handleMessageEditSubmit({ text: "", files: [] }));

    expect(setMessages).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.editing).not.toBeNull();
  });

  it("ignores a submit for a message that has since gone", () => {
    const { result, setMessages, sendMessage } = harness();

    act(() => result.current.handleMessageEditStart("gone"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(setMessages).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
