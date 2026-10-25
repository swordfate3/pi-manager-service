import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStableSemver } from "../protocol/software-metadata.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 256 * 1024;
const WEB_PACKAGE_NAME = "@kkkiio/pi-web-ui";
const MANAGER_PACKAGE_NAME = "@swordfate/pi-manager";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export type VersionStatus = Readonly<{
  status: "checking" | "ok" | "partial" | "unavailable";
  checkedAt?: number;
  pi?: Readonly<{ version: string }>;
  webUi?: Readonly<{ version: string; build: string }>;
  hub?: Readonly<{ version: string; build?: string }>;
}>;

export type LatestVersions = Readonly<{
  pi?: Readonly<{ version: string }>;
  webUi?: Readonly<{ version: string; build: string }>;
}>;

export type VersionFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type VersionSource = (signal: AbortSignal) => Promise<LatestVersions>;

export type VersionStatusOptions = {
  hub?: { version: string; build?: string };
  source?: VersionSource;
  fetch?: VersionFetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Version source unavailable");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Version source response too large");
  }
  if (!response.body) throw new Error("Version source response unavailable");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Version source response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return JSON.parse((await boundedBody(response, signal)).toString("utf8"));
  } catch {
    throw new Error("Invalid version source response");
  }
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, signal));
  } catch {
    throw new Error("Invalid version source response");
  }
}

async function getResponse<T>(
  fetcher: VersionFetch,
  url: string,
  signal: AbortSignal,
  headers: HeadersInit | undefined,
  timeoutMs: number,
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("Version source aborted");
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Version source timed out"));
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Version source aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetcher(url, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: { Accept: "application/json", ...headers },
        });
        return read(response, requestSignal);
      }),
      expired,
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function getJson(
  fetcher: VersionFetch,
  url: string,
  signal: AbortSignal,
  headers: HeadersInit | undefined,
  timeoutMs: number,
) {
  return getResponse(fetcher, url, signal, headers, timeoutMs, boundedJson);
}

function getText(
  fetcher: VersionFetch,
  url: string,
  signal: AbortSignal,
  headers: HeadersInit | undefined,
  timeoutMs: number,
) {
  return getResponse(fetcher, url, signal, headers, timeoutMs, boundedText);
}

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const ATOM_COMMIT_ID = /^tag:github.com,2008:Grit::Commit\/([a-f0-9]{40})$/;

/** A deliberately narrow Atom reader: accept only GitHub's fixed feed and its first direct entry ID. */
function firstAtomCommit(xml: string): string | undefined {
  const stack: string[] = [];
  let index = 0;
  let rootSeen = false;
  let entrySeen = false;
  let idSeen = false;
  let idClosed = false;
  let idInvalid = false;
  let idText = "";
  const inFirstId = () =>
    entrySeen && stack.length === 3 && stack[0] === "feed" && stack[1] === "entry" && stack[2] === "id";

  while (index < xml.length) {
    const nextTag = xml.indexOf("<", index);
    const textEnd = nextTag < 0 ? xml.length : nextTag;
    const text = xml.slice(index, textEnd);
    if (inFirstId()) {
      if (text.includes("&")) idInvalid = true;
      idText += text;
    } else if (!stack.length && text.trim()) {
      return undefined;
    }
    if (nextTag < 0) break;
    index = nextTag;

    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end < 0) return undefined;
      if (inFirstId()) idInvalid = true;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end < 0) return undefined;
      if (inFirstId()) idInvalid = true;
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end < 0) return undefined;
      if (inFirstId()) idInvalid = true;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<!", index)) return undefined;

    let end = index + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === xml.length || quote) return undefined;
    const source = xml.slice(index + 1, end).trim();
    index = end + 1;

    const closing = source.startsWith("/");
    if (closing) {
      const match = /^\/([A-Za-z][A-Za-z0-9._-]*(?::[A-Za-z][A-Za-z0-9._-]*)?)\s*$/.exec(source);
      if (!match || stack.at(-1) !== match[1]) return undefined;
      const name = stack.pop();
      if (name === "id" && entrySeen && stack.length === 2 && stack[1] === "entry") idClosed = true;
      if (name === "entry" && entrySeen && stack.length === 1 && stack[0] === "feed") {
        const matchId = idSeen && idClosed && !idInvalid ? ATOM_COMMIT_ID.exec(idText) : undefined;
        return matchId?.[1];
      }
      if (name === "feed" && stack.length === 0) rootSeen = true;
      continue;
    }

    const selfClosing = source.endsWith("/");
    const opening = selfClosing ? source.slice(0, -1).trimEnd() : source;
    const tag = /^([A-Za-z][A-Za-z0-9._-]*(?::[A-Za-z][A-Za-z0-9._-]*)?)([\s\S]*)$/.exec(opening);
    if (!tag) return undefined;
    const name = tag[1];
    let attributes = tag[2];
    const attrs: Record<string, string> = {};
    while (attributes.trim()) {
      attributes = attributes.trimStart();
      const attribute = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(attributes);
      if (!attribute || Object.hasOwn(attrs, attribute[1])) return undefined;
      attrs[attribute[1]] = attribute[3] ?? attribute[4];
      attributes = attributes.slice(attribute[0].length);
    }

    if (!rootSeen && !stack.length) {
      if (name !== "feed" || attrs.xmlns !== ATOM_NAMESPACE || selfClosing) return undefined;
    } else if (!stack.length) {
      return undefined;
    } else if (Object.hasOwn(attrs, "xmlns")) {
      return undefined;
    } else if (name === "entry" && stack.length === 1 && stack[0] === "feed" && !entrySeen) {
      entrySeen = true;
    } else if (inFirstId()) {
      idInvalid = true;
    }

    if (entrySeen && name === "id" && stack.length === 2 && stack[0] === "feed" && stack[1] === "entry") {
      if (idSeen) idInvalid = true;
      idSeen = true;
      if (Object.keys(attrs).length) idInvalid = true;
    }

    if (selfClosing) {
      if (name === "id" && entrySeen && stack.length === 2 && stack[1] === "entry") idClosed = true;
      if (name === "entry" && entrySeen && stack.length === 1 && stack[0] === "feed") return undefined;
    } else {
      stack.push(name);
    }
  }
  return undefined;
}

/** Read only the fixed, public package sources; a single immutable Git revision supplies Web UI version and build. */
export async function fetchLatestVersions(
  fetcher: VersionFetch,
  signal: AbortSignal,
  // Three sequential GitHub stages (REST ref, Atom fallback, immutable raw files)
  // must fit comfortably inside createVersionStatus's 8-second overall deadline.
  requestTimeoutMs = 2_000,
): Promise<LatestVersions> {
  const settled = await Promise.allSettled([
    getJson(
      fetcher,
      "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
      signal,
      undefined,
      requestTimeoutMs,
    ),
    getJson(
      fetcher,
      "https://api.github.com/repos/swordfate3/pi-web-ui/git/ref/heads/main",
      signal,
      {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pi-web-ui-hub-version-check",
      },
      requestTimeoutMs,
    ),
  ]);
  let pi: LatestVersions["pi"];
  const piPayload = settled[0].status === "fulfilled" ? settled[0].value : undefined;
  if (isRecord(piPayload) && piPayload.name === PI_PACKAGE_NAME && isStableSemver(piPayload.version))
    pi = Object.freeze({ version: piPayload.version });

  let refPayload: unknown = settled[1].status === "fulfilled" ? settled[1].value : undefined;
  const isValidRef = (payload: unknown) => {
    const object = isRecord(payload) ? payload.object : undefined;
    return isRecord(object) && object.type === "commit" && typeof object.sha === "string" && COMMIT.test(object.sha);
  };
  if (!isValidRef(refPayload)) {
    refPayload = undefined;
    if (signal.aborted) throw new Error("Version source aborted");
    try {
      const atom = await getText(
        fetcher,
        "https://github.com/swordfate3/pi-web-ui/commits/main.atom",
        signal,
        { Accept: "application/atom+xml" },
        requestTimeoutMs,
      );
      const revision = firstAtomCommit(atom);
      if (revision) refPayload = { object: { type: "commit", sha: revision } };
    } catch {
      if (signal.aborted) throw new Error("Version source aborted");
    }
  }
  const object = isRecord(refPayload) ? refPayload.object : undefined;
  let webUi: LatestVersions["webUi"];
  if (isRecord(object) && object.type === "commit" && typeof object.sha === "string" && COMMIT.test(object.sha)) {
    if (signal.aborted) throw new Error("Version source aborted");
    const revision = object.sha;
    const webResults = await Promise.allSettled([
      getJson(
        fetcher,
        `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/package.json`,
        signal,
        undefined,
        requestTimeoutMs,
      ),
      getJson(
        fetcher,
        `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/dist/build-manifest.json`,
        signal,
        undefined,
        requestTimeoutMs,
      ),
    ]);
    const webPayload = webResults[0].status === "fulfilled" ? webResults[0].value : undefined;
    const manifestPayload = webResults[1].status === "fulfilled" ? webResults[1].value : undefined;
    const source = isRecord(manifestPayload) ? manifestPayload.source : undefined;
    if (
      isRecord(webPayload) &&
      webPayload.name === WEB_PACKAGE_NAME &&
      isStableSemver(webPayload.version) &&
      isRecord(source) &&
      typeof source.sha256 === "string" &&
      SHA256.test(source.sha256)
    )
      webUi = Object.freeze({ version: webPayload.version, build: source.sha256 });
  }

  if (signal.aborted) throw new Error("Version source aborted");
  if (!pi && !webUi) throw new Error("Public version metadata unavailable");
  return Object.freeze({ ...(pi ? { pi } : {}), ...(webUi ? { webUi } : {}) });
}

// Vite replaces this only in the standalone Hub bundle. Source execution uses disk metadata below.
declare const __PI_WEB_HUB_METADATA__: Readonly<{ version: string; build: string }> | undefined;

/** Capture the Hub's loaded build identity, even when deployed without the surrounding package. */
export function captureHubMetadata(moduleUrl = import.meta.url): { version: string; build?: string } | undefined {
  if (typeof __PI_WEB_HUB_METADATA__ !== "undefined") {
    const embedded = __PI_WEB_HUB_METADATA__;
    if (embedded && isStableSemver(embedded.version) && SHA256.test(embedded.build))
      return Object.freeze({ version: embedded.version, build: embedded.build });
    return undefined;
  }
  let directory = path.dirname(fileURLToPath(moduleUrl));
  let root: string | undefined;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const packagePath = path.join(directory, "package.json");
      if (statSync(packagePath).size > 32 * 1024) throw new Error();
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
      if (isRecord(manifest) && manifest.name === MANAGER_PACKAGE_NAME && isStableSemver(manifest.version)) {
        root = directory;
        break;
      }
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!root) return undefined;
  try {
    const packagePath = path.join(root, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    let build: string | undefined;
    try {
      const buildPath = path.join(root, "dist", "build-manifest.json");
      if (statSync(buildPath).size > MAX_BODY_BYTES) throw new Error();
      const buildManifest = JSON.parse(readFileSync(buildPath, "utf8")) as unknown;
      const source = isRecord(buildManifest) ? buildManifest.source : undefined;
      if (isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) build = source.sha256;
    } catch {
      // Build metadata is optional, but the package version is always the running Hub's own.
    }
    return Object.freeze({ version: manifest.version as string, ...(build ? { build } : {}) });
  } catch {
    return undefined;
  }
}

/** Background-only, single-flight version lookup with bounded requests and cooldown even after failures. */
export function createVersionStatus(options: VersionStatusOptions = {}) {
  const now = options.now ?? Date.now;
  const cacheMs = Math.max(CACHE_MS, options.cacheMs ?? 0);
  const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const source =
    options.source ??
    (async (_signal: AbortSignal): Promise<LatestVersions> => {
      // The extracted Manager has no published release origin yet. Callers may
      // inject an explicit reviewed source; the default must not treat the old
      // Web repository as a Manager release channel or perform network I/O.
      throw new Error("Manager release source is not configured");
    });
  const localHub = options.hub ?? captureHubMetadata();
  const hub = localHub ? Object.freeze({ ...localHub }) : undefined;
  let status: VersionStatus = Object.freeze({ status: "checking", ...(hub ? { hub } : {}) });
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let activeTimeout: ReturnType<typeof setTimeout> | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  let nextCheckAt = 0;
  let closed = false;

  const check = (): Promise<void> => {
    if (closed || inFlight) return inFlight ?? Promise.resolve();
    if (now() < nextCheckAt) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller = new AbortController();
    const active = controller;
    let rejectTimeout!: (error: Error) => void;
    const expired = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    rejectActive = rejectTimeout;
    activeTimeout = setTimeout(() => {
      active.abort();
      rejectTimeout(new Error("Version check timed out"));
    }, timeoutMs);
    activeTimeout.unref?.();
    inFlight = (async () => {
      try {
        const result = await Promise.race([Promise.resolve().then(() => source(active.signal)), expired]);
        if (closed || active.signal.aborted) return;
        if (!isRecord(result) || Object.keys(result).some((key) => key !== "pi" && key !== "webUi"))
          throw new Error("Invalid version source result");
        const pi = result.pi;
        const webUi = result?.webUi;
        const validPi = isRecord(pi) && Object.keys(pi).join(",") === "version" && isStableSemver(pi.version);
        const validWeb =
          isRecord(webUi) &&
          Object.keys(webUi).sort().join(",") === "build,version" &&
          isStableSemver(webUi.version) &&
          typeof webUi.build === "string" &&
          SHA256.test(webUi.build);
        if (!validPi && !validWeb) throw new Error("Invalid version source result");
        status = Object.freeze({
          status: validPi && validWeb ? "ok" : "partial",
          checkedAt: now(),
          ...(validPi ? { pi: Object.freeze({ version: pi.version }) } : {}),
          ...(validWeb ? { webUi: Object.freeze({ version: webUi.version, build: webUi.build }) } : {}),
          ...(hub ? { hub } : {}),
        });
      } catch {
        if (closed) return;
        // A failed check never presents stale source values as a successful observation.
        status = Object.freeze({ status: "unavailable", checkedAt: now(), ...(hub ? { hub } : {}) });
      } finally {
        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeout = undefined;
        rejectActive = undefined;
        if (controller === active) controller = undefined;
        inFlight = undefined;
        if (!closed) {
          nextCheckAt = now() + cacheMs;
          timer = setTimeout(
            () => {
              timer = undefined;
              void check();
            },
            Math.max(0, nextCheckAt - now()),
          );
          timer.unref?.();
        }
      }
    })();
    return inFlight;
  };

  return {
    snapshot: () => status,
    // Hub startup is strictly offline. A browser's first session-list request
    // schedules the public check without delaying the response.
    ensureStarted: () => {
      void check();
    },
    /** Test/maintenance seam. HTTP handlers use snapshot only and never await this. */
    refresh: check,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (activeTimeout) clearTimeout(activeTimeout);
      activeTimeout = undefined;
      controller?.abort();
      rejectActive?.(new Error("Version checker closed"));
      rejectActive = undefined;
    },
  };
}
