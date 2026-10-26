export const TASK_STATES = [
  "pending_approval",
  "queued",
  "waiting_idle",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TaskRequest {
  readonly key: string;
  readonly requester: string;
  readonly target: string;
  readonly action: string;
  readonly payload: JsonValue;
}

export interface TaskRecord extends TaskRequest {
  readonly id: string;
  readonly revision: number;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: JsonValue;
}

export interface TaskStoreOpenOptions {
  readonly recoverStaleLock?: boolean;
}

export interface TaskTransitionOptions {
  readonly expectedRevision?: number;
  readonly result?: JsonValue;
}
