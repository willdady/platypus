import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ARTIFACT_CONTENT_MAX_BYTES } from "@platypus/schemas";
import {
  authMock,
  push,
  resetSharedSpies,
  stubAcceptedSave,
  stubPendingSave,
  stubRejectedSave,
  toastError,
  toastSuccess,
} from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);

import { ArtifactUploadButton } from "./artifact-upload";

function renderUpload(onUploaded = vi.fn()) {
  const view = render(
    <ArtifactUploadButton
      orgId="org1"
      workspaceId="ws1"
      onUploaded={onUploaded}
    />,
  );
  const input = screen.getByLabelText<HTMLInputElement>(
    "Choose a file to upload",
  );
  return { ...view, input, onUploaded };
}

function choose(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

function file(content: BlobPart, name: string) {
  return new File([content], name, { type: "text/plain" });
}

beforeEach(() => {
  resetSharedSpies();
});

describe("ArtifactUploadButton", () => {
  it("uploads a text file as the type its extension names", async () => {
    const fetchMock = stubAcceptedSave({
      id: "a1",
      title: "notes",
      type: "markdown",
    });
    const { input, onUploaded } = renderUpload();

    choose(input, file("# Release notes\n", "notes.md"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("http://test/organizations/org1/workspaces/ws1/artifacts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      title: "notes.md",
      type: "markdown",
      content: "# Release notes\n",
    });

    expect(toastSuccess).toHaveBeenCalledWith("Artifact created");
    expect(onUploaded).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/artifacts/a1");
  });

  it("takes a code file's language from its extension", async () => {
    const fetchMock = stubAcceptedSave({ id: "a2" });
    const { input } = renderUpload();

    choose(input, file("print('hi')\n", "script.py"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      title: "script.py",
      type: "code",
      language: "py",
    });
  });

  it("refuses a file over the limit without sending it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { input } = renderUpload();

    choose(input, file("x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1), "big.md"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("big.md is larger than 512 KB"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses a file that does not decode as text without sending it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { input } = renderUpload();

    choose(input, file(new Uint8Array([0xff, 0xfe, 0x00]), "picture.png"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("picture.png is not a text file"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the reason the route gave for refusing the upload", async () => {
    stubRejectedSave("Artifact content is not text");
    const { input } = renderUpload();

    choose(input, file("not really text", "notes.md"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Artifact content is not text"),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the reason the route gave for refusing the title", async () => {
    stubRejectedSave([
      {
        path: ["title"],
        message: "Too big: expected string to have <=200 characters",
      },
    ]);
    const { input } = renderUpload();

    choose(input, file("body", `${"x".repeat(201)}.md`));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Too big: expected string to have <=200 characters",
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("says the file is uploading while the request is in flight", async () => {
    const { fetchMock, resolve } = stubPendingSave({ id: "a1" });
    const { input } = renderUpload();

    choose(input, file("body", "notes.md"));

    expect(
      await screen.findByRole("button", { name: "Uploading..." }),
    ).toBeDisabled();
    resolve();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
