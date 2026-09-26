import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toastMock, stubSaveSequence } from "@/lib/list-test-harness";

vi.mock("sonner", () => toastMock);

import { toast } from "sonner";
import { useSandboxUploads } from "./use-sandbox-uploads";

const FILE_URL = "http://test/organizations/org1/workspaces/ws1/sandbox/file";

/** Renders the hook's dialog and hands back its `upload`. */
const harness = () => {
  let upload!: ReturnType<typeof useSandboxUploads>["upload"];
  const Harness = () => {
    const sandbox = useSandboxUploads(FILE_URL);
    upload = sandbox.upload;
    return <>{sandbox.dialog}</>;
  };
  render(<Harness />);
  return (files: File[]) => upload(files);
};

const file = (name: string, body = "a,b") => new File([body], name);

beforeEach(() => vi.clearAllMocks());

describe("useSandboxUploads", () => {
  it("puts each file at the Sandbox root under its own name", async () => {
    const fetchMock = stubSaveSequence(
      { status: 200, body: {} },
      { status: 200, body: {} },
    );
    const upload = harness();
    const a = file("a.csv");
    const b = file("b.txt", "hello");

    await expect(upload([a, b])).resolves.toEqual([
      { path: "a.csv", filename: "a.csv", size: 3 },
      { path: "b.txt", filename: "b.txt", size: 5 },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${FILE_URL}?path=a.csv`,
      `${FILE_URL}?path=b.txt`,
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      body: a,
    });
  });

  it("asks before overwriting a taken path, then re-sends with the flag", async () => {
    const fetchMock = stubSaveSequence(
      { status: 409, body: { error: "Path already exists: a.csv" } },
      { status: 200, body: {} },
    );
    const upload = harness();

    let result: Promise<unknown>;
    act(() => {
      result = upload([file("a.csv")]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));

    await expect(result!).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${FILE_URL}?path=a.csv&overwrite=true`,
    );
  });

  it("sends nothing more when the overwrite is cancelled", async () => {
    const fetchMock = stubSaveSequence({
      status: 409,
      body: { error: "Path already exists: a.csv" },
    });
    const upload = harness();

    let result: Promise<unknown>;
    act(() => {
      result = upload([file("a.csv")]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await expect(result!).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a second Send while the first is still uploading", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: {} });
    const upload = harness();
    const files = [file("a.csv")];

    const first = upload(files);
    await expect(upload(files)).rejects.toThrow();
    await expect(first).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails on any other error, and a retry sends only what has not landed", async () => {
    const fetchMock = stubSaveSequence(
      { status: 200, body: {} },
      { status: 500, body: { error: "Sandbox unreachable" } },
      { status: 200, body: {} },
    );
    const upload = harness();
    const files = [file("a.csv"), file("b.csv")];

    await expect(upload(files)).rejects.toThrow();
    expect(toast.error).toHaveBeenCalledWith("Sandbox unreachable");

    await expect(upload(files)).resolves.toHaveLength(2);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe(`${FILE_URL}?path=b.csv`);
  });
});
