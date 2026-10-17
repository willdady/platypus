/**
 * End-to-end smoke test against a running stack (`pnpm dev`):
 *
 *     pnpm smoke
 *
 * Signs in as the admin, opens a throwaway Organization and Workspace through
 * the UI, sends a chat message and waits for the streamed reply. The model is
 * a local stub of the OpenAI Chat Completions API, so no provider key is
 * needed; the backend must be able to reach this machine on `127.0.0.1`. The
 * Organization is deleted afterwards, taking everything in it.
 *
 * Environment (defaults match the `.example.env` files):
 *   FRONTEND_URL    http://localhost:3001
 *   BACKEND_URL     http://localhost:4001
 *   ADMIN_EMAIL     admin@example.com
 *   ADMIN_PASSWORD  admin123
 *   HEADED          set to watch the browser
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3001";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4001";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";

const REPLY = "Hello from the smoke test";
const MODEL = "smoke-model";

// Answers every completion with REPLY: streamed as SSE chunks when asked to
// stream (the chat turn), as one JSON body otherwise (e.g. title generation).
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
    const base = { id: "smoke", created: 0, model: MODEL };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: REPLY },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    // Split the reply so the UI has to assemble more than one delta.
    const words = REPLY.split(" ");
    res.write(chunk({ role: "assistant", content: "" }));
    words.forEach((word, i) =>
      res.write(chunk({ content: i === 0 ? word : ` ${word}` })),
    );
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

const browser = await chromium.launch({ headless: !process.env.HEADED });
const page = await browser.newPage();
const api = (path: string) => `${BACKEND_URL}${path}`;
const suffix = Date.now().toString(36);
let orgId: string | undefined;

try {
  await page.goto(`${FRONTEND_URL}/sign-in`);
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

  // Setup goes through the API with the browser's session: the smoke is the
  // chat path, not the create forms.
  const post = async <T>(path: string, data: object) => {
    const response = await page.request.post(api(path), {
      data,
      headers: { origin: FRONTEND_URL },
    });
    if (!response.ok()) {
      throw new Error(
        `POST ${path}: ${response.status()} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };
  const orgName = `Smoke ${suffix}`;
  const workspaceName = `Smoke workspace ${suffix}`;
  orgId = (await post<{ id: string }>("/organizations", { name: orgName })).id;
  await post(`/organizations/${orgId}/workspaces`, {
    name: workspaceName,
    provider: {
      name: "Smoke stub",
      providerType: "OpenAI",
      apiKey: "smoke",
      baseUrl: stubUrl,
      apiMode: "chat",
      modelIds: [MODEL],
      taskModelId: MODEL,
      memoryExtractionModelId: MODEL,
    },
  });

  await page.goto(FRONTEND_URL);
  await page.getByRole("link", { name: orgName }).click();
  await page.getByRole("link", { name: workspaceName }).click();
  await page.getByRole("link", { name: "New chat" }).click();

  const composer = page.getByPlaceholder("What would you like to know?");
  await composer.fill("Say hello");
  await composer.press("Enter");
  await page.getByText(REPLY).waitFor({ timeout: 30_000 });
  console.log("smoke: ok");
} catch (error) {
  const screenshot = join(tmpdir(), "platypus-smoke-failure.png");
  await page.screenshot({ path: screenshot }).catch(() => {});
  console.error(`smoke: failed (screenshot: ${screenshot})`);
  throw error;
} finally {
  if (orgId) {
    const response = await page.request
      .delete(api(`/organizations/${orgId}`), {
        headers: { origin: FRONTEND_URL },
      })
      .catch(() => null);
    if (!response?.ok()) {
      console.error(`smoke: could not delete Organization ${orgId}`);
      process.exitCode = 1;
    }
  }
  await browser.close();
  stub.close();
}
