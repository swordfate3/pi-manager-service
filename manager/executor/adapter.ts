import type { JsonValue, TaskRequest, TaskRecord } from "../contracts.ts";

/** Trusted construction-time seam; never loaded from workspace code or request data.
 * Future handlers must supply their immutable admin policy and actual supported actions.
 * validate is repeated before approval and execution. execute gets only the stored request.
 */
export interface TaskBackendAdapter {
  readonly policy: JsonValue;
  readonly actions: readonly string[];
  validate(request: TaskRequest): Promise<void>;
  execute(task: TaskRecord): Promise<{ status: string; instanceId?: string }>;
  resources(requester: string): { instanceId: string }[];
  close(): Promise<void>;
}
