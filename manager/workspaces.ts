import { lstat, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHubConfig } from "../hub/config.ts";
import type { WorkspaceBrowseQuery, WorkspaceBrowserView, WorkspaceDirectoryPage, WorkspaceSelection } from "./api.ts";
import type { ExecutorConfig } from "./config.ts";
import { identifier, keys, ManagerError, record, requireThat } from "./validation.ts";
import { enrollmentConfig } from "./enrollment/client.ts";
import { runtimeProfileSources } from "./backends/runtime-profile.ts";

const DIRECTORY_LIMIT = 200;

function contains(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }

function relativePath(value: unknown): string {
  requireThat(typeof value === "string" && value.length <= 4096 && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"));
  if (value === "") return value;
  const segments = value.split("/");
  requireThat(segments.every(segment => segment !== "" && segment !== "." && segment !== ".."));
  return value;
}

function configuredRelativePath(value: unknown): string {
  requireThat(typeof value === "string" && value.length <= 512 && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."));
  const normalized = path.posix.normalize(value);
  return normalized === "." ? "" : normalized;
}

export function workspaceSelection(value: unknown): WorkspaceSelection {
  const selection = record(value); keys(selection, ["root", "path"]);
  return { root: identifier(selection.root), path: relativePath(selection.path) };
}

function browserQuery(value: unknown): WorkspaceBrowseQuery {
  const query = workspaceSelection(value);
  return query;
}

async function canonicalFuturePath(value: string): Promise<string> {
  let current = value;
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(current);
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}

function configuredRoots(config: ExecutorConfig): Readonly<Record<string, string>> {
  const backend = config.docker ?? config.native;
  return backend?.workspaceRoots ?? {};
}

function configuredProtectedPaths(config: ExecutorConfig): string[] {
  const result = [config.stateRoot, path.dirname(config.submitSocket), path.dirname(config.adminSocket), fileURLToPath(new URL("..", import.meta.url))];
  if (config.docker) {
    result.push(config.docker.stateRoot, config.docker.socketPath, ...(config.docker.protectedRoots ?? []));
    if (config.docker.web) {
      result.push(config.docker.web.packageRoot);
      if (config.docker.web.hubConfigFile) {
        result.push(config.docker.web.hubConfigFile);
        const hub = readHubConfig(config.docker.web.hubConfigFile); result.push(hub.stateDir, hub.runtimeDir);
      }
      if (config.docker.web.enrollment) {
        const e = enrollmentConfig(config.docker.web.enrollment);
        result.push(path.dirname(e.socketPath), e.authorityFile);
      }
      if (config.docker.web.provider) result.push(config.docker.web.provider.packageRoot);
    }
    result.push(...runtimeProfileSources(config.docker.runtimeProfile));
  }
  if (config.native) {
    result.push(config.native.stateRoot, config.native.agentRoot, config.native.piExecutable);
    if (config.native.provider) result.push(config.native.provider.extensionPath);
    if (config.native.web) {
      result.push(config.native.web.extensionPath, config.native.web.hubConfigFile);
      const hub = readHubConfig(config.native.web.hubConfigFile); result.push(hub.stateDir, hub.runtimeDir);
    }
  }
  return result;
}

/** Executor-owned filesystem policy. No requester path reaches an adapter without this resolver. */
export class WorkspacePolicy {
  readonly #config: ExecutorConfig;
  readonly #roots: Readonly<Record<string, string>>;
  readonly #protected: readonly string[];
  readonly #browser: WorkspaceBrowserView | null;

  private constructor(config: ExecutorConfig, roots: Record<string, string>, protectedPaths: string[]) {
    this.#config = structuredClone(config); this.#roots = Object.freeze(roots); this.#protected = Object.freeze(protectedPaths);
    this.#browser = config.workspaceBrowser ? Object.freeze({ defaultRoot: config.workspaceBrowser.defaultRoot,
      roots: Object.freeze(Object.keys(roots).map(id => Object.freeze({ id, label: id }))) }) as WorkspaceBrowserView : null;
  }

  static async open(config: ExecutorConfig): Promise<WorkspacePolicy> {
    try {
      const roots: Record<string, string> = {};
      for (const [id, configured] of Object.entries(configuredRoots(config))) {
        identifier(id); const canonical = await realpath(configured);
        requireThat(canonical === configured && (await stat(canonical)).isDirectory()); roots[id] = canonical;
      }
      const protectedPaths = await Promise.all(configuredProtectedPaths(config).map(canonicalFuturePath));
      // These are administrator-attested daemon coordinates, not executor-visible
      // files. In particular, do NOT realpath/stat through chat's 0700 parents.
      if (config.docker?.web?.enrollment) {
        const e = enrollmentConfig(config.docker.web.enrollment);
        protectedPaths.push(e.registryHostDirectory, e.exportHostDirectory);
      }
      if (config.workspaceBrowser) {
        const home = await realpath(config.workspaceBrowser.home);
        requireThat(home === config.workspaceBrowser.home && (await stat(home)).isDirectory());
        for (const root of Object.values(roots)) requireThat(root !== home && contains(home, root));
        requireThat(Object.hasOwn(roots, config.workspaceBrowser.defaultRoot));
        // Roots may be ancestors of private branches, but can never be inside one.
        for (const root of Object.values(roots)) requireThat(!protectedPaths.some(privatePath => contains(privatePath, root)));
      }
      return new WorkspacePolicy(config, roots, [...new Set(protectedPaths)]);
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      throw new ManagerError(400);
    }
  }

  browser(): WorkspaceBrowserView | null { return this.#browser ? structuredClone(this.#browser) : null; }

  async #directory(selection: WorkspaceSelection, allowBrowserRoot: boolean): Promise<string> {
    try {
      requireThat(Object.hasOwn(this.#roots, selection.root));
      const root = this.#roots[selection.root];
      let current = root;
      if (selection.path !== "") for (const segment of selection.path.split("/")) {
        current = path.join(current, segment);
        const metadata = await lstat(current); requireThat(metadata.isDirectory() && !metadata.isSymbolicLink());
      }
      const canonical = await realpath(current);
      requireThat(canonical === current && contains(root, canonical) && (await stat(canonical)).isDirectory());
      if (!(allowBrowserRoot && selection.path === "")) requireThat(!this.#protected.some(privatePath => overlaps(canonical, privatePath)));
      return canonical;
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      throw new ManagerError(400);
    }
  }

  async resolve(value: unknown): Promise<WorkspaceSelection> {
    let selection: WorkspaceSelection;
    if (typeof value === "string") {
      const id = identifier(value); requireThat(Object.hasOwn(this.#config.workspaces, id));
      const configured = this.#config.workspaces[id];
      selection = { root: configured.root, path: configuredRelativePath(configured.path) };
    } else {
      requireThat(this.#browser !== null);
      selection = workspaceSelection(value);
    }
    await this.#directory(selection, false);
    return structuredClone(selection);
  }

  async browse(value: unknown): Promise<WorkspaceDirectoryPage> {
    requireThat(this.#browser !== null);
    const query = browserQuery(value);
    const directory = await this.#directory(query, true);
    const directories: { name: string; path: string }[] = [];
    let truncated = false;
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        let childPath: string;
        try { relativePath(entry.name); childPath = query.path ? `${query.path}/${entry.name}` : entry.name; }
        catch { continue; }
        const child = path.join(directory, entry.name);
        try {
          const metadata = await lstat(child);
          if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(child) !== child || this.#protected.some(privatePath => overlaps(child, privatePath))) continue;
        } catch { continue; }
        if (directories.length === DIRECTORY_LIMIT) { truncated = true; break; }
        directories.push({ name: entry.name, path: childPath });
      }
      return { root: query.root, path: query.path, directories, truncated };
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      throw new ManagerError(400);
    }
  }
}
