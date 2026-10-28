import type { TaskRecord } from "./contracts.ts";
export interface WorkspaceSelection { root: string; path: string }
export interface WorkspaceBrowseQuery { root: string; path: string }
export interface WorkspaceDirectoryPage { root: string; path: string; directories: { name: string; path: string }[]; truncated: boolean }
export type LocalBrowseSort = "name-asc" | "name-desc" | "modified-desc" | "modified-asc";
export interface LocalBrowseQuery extends WorkspaceSelection { query: string; sort: LocalBrowseSort; offset: number }
export interface LocalWorkspaceEntry { name: string; path: string; kind: "directory" | "file"; modifiedAt: number }
export interface LocalWorkspacePage extends WorkspaceDirectoryPage {
  entries: LocalWorkspaceEntry[]; query: string; sort: LocalBrowseSort; offset: number; total: number; nextOffset: number | null;
}
export type TaskSubmission = { key: string; action: "create"; target: string; workspace: string | WorkspaceSelection } | { key: string; action: "stop" | "start"; target: string };
export type TaskView = Omit<TaskRecord, "result"> & { result?: { status: string; instanceId?: string } };
export interface TaskClient {
  submitTask(request: TaskSubmission): Promise<TaskView>;
  getTask(taskId: string): Promise<TaskView>;
  listTasks(): Promise<TaskView[]>;
  versions(options?: VersionQueryOptions): Promise<VersionCatalogPage>;
}
export interface ApprovalBinding { taskId: string; revision: number; requestHash: string; policyHash: string }
export interface TaskReview { task: TaskView; binding: ApprovalBinding; requiresFreshApproval: boolean }
export interface WorkspaceChoice { id: string; label: string }
export interface WorkspaceBrowserView { defaultRoot: string; roots: WorkspaceChoice[] }
export interface Capabilities { native: boolean; isolation: "trusted-local-development" | "fixed-container" | "unavailable"; enrollment: boolean; docker: boolean; updates: false; approval: boolean }
export interface VersionQueryOptions { query?: string; cursor?: string; limit?: number }
export interface VersionCatalogPage {
  readonly status: "fresh" | "stale" | "unavailable";
  readonly versions: readonly string[];
  readonly checkedAt: number | null;
  readonly error?: "registry-unavailable";
  readonly nextCursor?: string;
}
