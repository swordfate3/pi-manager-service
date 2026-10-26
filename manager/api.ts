import type { TaskRecord } from "./contracts.ts";
export type TaskSubmission = { key: string; action: "create"; target: string; workspace: string } | { key: string; action: "stop" | "start"; target: string };
export type TaskView = Omit<TaskRecord, "result"> & { result?: { status: string; instanceId?: string } };
export interface TaskClient {
  submitTask(request: TaskSubmission): Promise<TaskView>;
  getTask(taskId: string): Promise<TaskView>;
  listTasks(): Promise<TaskView[]>;
}
export interface ApprovalBinding { taskId: string; revision: number; requestHash: string; policyHash: string }
export interface TaskReview { task: TaskView; binding: ApprovalBinding; requiresFreshApproval: boolean }
export interface WorkspaceChoice { id: string; label: string }
export interface Capabilities { native: boolean; isolation: "trusted-local-development" | "fixed-container" | "unavailable"; enrollment: boolean; docker: boolean; updates: false; approval: boolean }
