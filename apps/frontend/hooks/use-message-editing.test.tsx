import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FileUIPart, UIMessage } from "ai";
import { useMessageEditing } from "./use-message-editing";
import type { TurnMessage } from "./use-chat-turn";
import { reportPdf, screenshotPng } from "@/test/chat-test-fixtures";

const transcript: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [
      reportPdf,
      screenshotPng,
      { type: "text", text: "What does this say?" },
    ],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "It says X." }],
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "And this?" }] },
];

function harness(messages: UIMessage[] = transcript, started = true) {
  const resend = vi
    .fn<(truncateAt: number, message: TurnMessage) => boolean>()
    .mockReturnValue(started);
  const view = renderHook(() => useMessageEditing(messages, resend));
  return { ...view, resend };
}

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
      attachments: [reportPdf, screenshotPng],
    });
  });

  it("closes on cancel without touching the transcript", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() => result.current.handleMessageEditCancel());

    expect(result.current.editing).toBeNull();
    expect(resend).not.toHaveBeenCalled();
  });
});

describe("useMessageEditing submitting an edit", () => {
  it("keeps the message's Sandbox uploads on the resent edit", () => {
    const upload = { path: "data.csv", size: 3 };
    const { result, resend } = harness([
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "data-sandbox-upload", data: upload },
          { type: "text", text: "Summarise it" },
        ],
      },
    ]);

    act(() => result.current.handleMessageEditStart("u1"));
    act(() => result.current.handleMessageEditSubmit({ text: "", files: [] }));

    expect(resend).toHaveBeenCalledWith(0, {
      text: "",
      files: [],
      sandboxUploads: [upload],
    });
  });

  it("resends from the edited message and closes once it started", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(resend).toHaveBeenCalledWith(0, { text: "Rewritten", files: [] });
    expect(result.current.editing).toBeNull();
  });

  it("resends from a message part-way down the transcript", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u2"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(resend.mock.calls[0][0]).toBe(2);
  });

  it("stays open when the resend is refused", () => {
    const { result, resend } = harness(transcript, false);

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(resend).toHaveBeenCalled();
    expect(result.current.editing?.messageId).toBe("u1");
  });

  it("sends attachments the user added while editing", () => {
    const added: FileUIPart = {
      type: "file",
      url: "data:text/plain;base64,aGk=",
      mediaType: "text/plain",
      filename: "extra.txt",
    };
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({
        text: "Both, please",
        files: [reportPdf, added],
      }),
    );

    expect(resend.mock.calls[0][1].files).toEqual([reportPdf, added]);
  });

  it("resends an edit left with attachments and no words", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "", files: [reportPdf] }),
    );

    expect(resend).toHaveBeenCalledWith(0, { text: "", files: [reportPdf] });
  });

  it("refuses an edit with neither text nor attachments", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("u1"));
    act(() => result.current.handleMessageEditSubmit({ text: "", files: [] }));

    expect(resend).not.toHaveBeenCalled();
    expect(result.current.editing).not.toBeNull();
  });

  it("ignores a submit for a message that has since gone", () => {
    const { result, resend } = harness();

    act(() => result.current.handleMessageEditStart("gone"));
    act(() =>
      result.current.handleMessageEditSubmit({ text: "Rewritten", files: [] }),
    );

    expect(resend).not.toHaveBeenCalled();
  });
});

describe("useMessageEditing on a message that invokes a Skill", () => {
  const withCommand: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "/blog-post about otters" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-loadSkill",
          toolCallId: "call-1",
          state: "output-available",
          input: { name: "blog-post" },
          output: { name: "blog-post", body: "Write a blog post." },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "Here you go." },
      ],
    },
  ];

  it("opens holding the command token and resubmits it leading the text", () => {
    const { result, resend } = harness(withCommand);

    act(() => result.current.handleMessageEditStart("u1"));
    expect(result.current.editing?.text).toBe("/blog-post about otters");

    act(() =>
      result.current.handleMessageEditSubmit({
        text: "/blog-post about platypuses",
        files: [],
      }),
    );

    expect(resend).toHaveBeenCalledWith(0, {
      text: "/blog-post about platypuses",
      files: [],
    });
  });
});
