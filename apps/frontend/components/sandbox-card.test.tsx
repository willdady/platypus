import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  toastMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubSaveSequence,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { SandboxCard } from "./sandbox-card";

const SANDBOX = {
  id: "sb1",
  workspaceId: "ws1",
  name: "Dev box",
  backend: "docker",
  config: {},
  adminEnv: {},
  userEnv: {},
  hasCredentials: false,
  transfer: { upload: true, download: true },
};

const FILE_URL = "http://test/organizations/org1/workspaces/ws1/sandbox/file";

const renderCard = (sandbox: unknown) => {
  mockScopedSWR({
    "/sandbox-backends": [{ backend: "docker", name: "Docker" }],
    "/ws1/sandbox": { data: sandbox },
  });
  return renderList(<SandboxCard orgId="org1" workspaceId="ws1" />);
};

const pickFile = (name = "photo.png") => {
  const file = new File([new Uint8Array([0, 1, 2])], name);
  fireEvent.change(screen.getByLabelText("File"), {
    target: { files: [file] },
  });
  return file;
};

beforeEach(resetListHarness);
afterEach(() => vi.unstubAllGlobals());

describe("SandboxCard", () => {
  it("renders nothing when the Workspace has no Sandbox", () => {
    const { container } = renderCard(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the Sandbox's backend", () => {
    renderCard(SANDBOX);
    expect(screen.getByText("Docker")).toBeInTheDocument();
  });

  it("uploads the file under its own name to the workspace root by default", async () => {
    const fetchMock = stubSaveSequence({
      status: 200,
      body: { message: "File uploaded" },
    });
    renderCard(SANDBOX);
    const file = pickFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("Uploaded photo.png")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `${FILE_URL}?path=photo.png`,
      expect.objectContaining({
        method: "PUT",
        body: file,
        credentials: "include",
      }),
    );
  });

  it("uploads into the chosen destination directory", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: {} });
    renderCard(SANDBOX);
    pickFile();
    fireEvent.change(screen.getByLabelText("Destination directory"), {
      target: { value: "in/data/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await screen.findByText("Uploaded in/data/photo.png");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${FILE_URL}?path=in%2Fdata%2Fphoto.png`,
    );
  });

  it("asks before overwriting a taken path and retries with the overwrite flag", async () => {
    const fetchMock = stubSaveSequence(
      { status: 409, body: { error: "Path already exists: photo.png" } },
      { status: 200, body: {} },
    );
    renderCard(SANDBOX);
    pickFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("Overwrite photo.png?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await screen.findByText("Uploaded photo.png");
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${FILE_URL}?path=photo.png&overwrite=true`,
    );
  });

  it("leaves the file alone when the overwrite is declined", async () => {
    const fetchMock = stubSaveSequence({
      status: 409,
      body: { error: "Path already exists: photo.png" },
    });
    renderCard(SANDBOX);
    pickFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await screen.findByText("Overwrite photo.png?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText("Overwrite photo.png?"),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a failed upload's error", async () => {
    stubSaveSequence({
      status: 413,
      body: { error: "File is larger than the 25 MiB transfer limit" },
    });
    renderCard(SANDBOX);
    pickFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText("File is larger than the 25 MiB transfer limit"),
    ).toBeInTheDocument();
  });

  it("disables the download until a path is typed", () => {
    renderCard(SANDBOX);
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });

  it("links the download to the route for the typed path", () => {
    renderCard(SANDBOX);
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "out/report.pdf" },
    });

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `${FILE_URL}?path=out%2Freport.pdf`,
    );
  });

  it.each([
    [{ upload: false, download: true }, "Upload", "Download"],
    [{ upload: true, download: false }, "Download", "Upload"],
  ])(
    "shows the unsupported message in place of a direction the backend lacks (%j)",
    (transfer, missing, present) => {
      renderCard({ ...SANDBOX, transfer });

      expect(
        screen.getByText("This Sandbox backend doesn't support file transfer"),
      ).toBeInTheDocument();
      const control = (name: string) =>
        screen.queryByRole("button", { name }) ??
        screen.queryByRole("link", { name });
      expect(control(missing)).not.toBeInTheDocument();
      expect(control(present)).toBeInTheDocument();
    },
  );
});
