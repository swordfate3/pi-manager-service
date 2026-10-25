import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { ConsoleMessage, Page, Request, Response, WebSocket } from "@playwright/test";

// Persist correlation hashes, never raw console/error text, URLs, query strings,
// credentials, paths, stack traces, headers or message/frame bodies.
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const requestIdentity = (request: Request) => ({
  urlHash: hash(request.url()),
  method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method())
    ? request.method()
    : "other",
});

export function observeBrowserErrors(page: Page) {
  const errors = {
    pageErrors: [] as { messageHash: string }[],
    consoleErrors: [] as { messageHash: string }[],
    requestFailures: [] as { urlHash: string; method: string; messageHash: string }[],
    httpFailures: [] as { urlHash: string; method: string; status: number }[],
    webSocketErrors: [] as { urlHash: string; messageHash: string }[],
  };
  const onError = (error: Error) => errors.pageErrors.push({ messageHash: hash(error.message) });
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") errors.consoleErrors.push({ messageHash: hash(message.text()) });
  };
  const onRequest = (request: Request) =>
    errors.requestFailures.push({
      ...requestIdentity(request),
      messageHash: hash(request.failure()?.errorText ?? "unknown"),
    });
  const onResponse = (response: Response) => {
    if (response.status() >= 400)
      errors.httpFailures.push({ ...requestIdentity(response.request()), status: response.status() });
  };
  const socketListeners = new Map<WebSocket, (error: string) => void>();
  const onSocket = (socket: WebSocket) => {
    const listener = (error: string) =>
      errors.webSocketErrors.push({ urlHash: hash(socket.url()), messageHash: hash(error) });
    socketListeners.set(socket, listener);
    socket.on("socketerror", listener);
  };
  page.on("pageerror", onError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequest);
  page.on("response", onResponse);
  page.on("websocket", onSocket);
  return {
    errors,
    assertClean() {
      for (const [kind, records] of Object.entries(errors)) assert.deepEqual(records, [], `Unexpected browser ${kind}`);
    },
    // No event exclusions. Stop only once the case is over, before intentionally
    // destroying the browser context and local servers.
    stop() {
      page.off("pageerror", onError);
      page.off("console", onConsole);
      page.off("requestfailed", onRequest);
      page.off("response", onResponse);
      page.off("websocket", onSocket);
      for (const [socket, listener] of socketListeners) socket.off("socketerror", listener);
      socketListeners.clear();
    },
  };
}

export function startVisualEvidence(file: string) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const evidence: Record<string, unknown>[] = [];
  const publish = (status: "in_progress" | "passed" | "failed") => {
    const temporary = `${file}.${runId}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          method: "Playwright Chromium fallback; real Pi + packaged Hub",
          status,
          runId,
          startedAt,
          expectedFailureExclusions: [],
          evidence,
        },
        null,
        2,
      )}\n`,
    );
    renameSync(temporary, file);
  };
  // Invalidate the previous run before starting Chromium or any local server.
  publish("in_progress");
  return {
    recordCase(record: Record<string, unknown>) {
      evidence.push(record);
      publish("in_progress");
    },
    finish(status: "passed" | "failed") {
      publish(status);
    },
  };
}
