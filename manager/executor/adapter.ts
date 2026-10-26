import type { JsonValue, TaskRequest, TaskRecord } from "../contracts.ts";
import type { Capabilities } from "../api.ts";

/** Trusted construction-time seam; never loaded from workspace code or request data.
 * Future handlers must supply their immutable admin policy and actual supported actions.
 * validate is repeated before approval and execution. execute gets only the stored request.
 */
export interface TaskBackendAdapter {
  readonly policy: JsonValue;
  readonly actions: readonly string[];
  readonly capabilities?: Pick<Capabilities, "native" | "docker" | "isolation"> & { enrollment?: boolean };
  /** Authoritative snapshot after running -> unknown recovery; never infer requester from resource labels. */
  restore?(records: readonly TaskRecord[]): void | Promise<void>;
  validate(request: TaskRequest): Promise<void>;
  execute(task: TaskRecord): Promise<{ status: string; instanceId?: string }>;
  resources(requester: string): { instanceId: string }[] | Promise<{ instanceId: string }[]>;
  close(): Promise<void>;
}
