import { ExecutorClient } from "./client.ts";
import type { ApprovalBinding, TaskReview, TaskView } from "../api.ts";
/** Import only from a private administrator entry, never the public service. */
export class AdminClient extends ExecutorClient {
  reviewTask(taskId: string): Promise<TaskReview> { return this.call({ op: "review", taskId }); }
  approveTask(binding: ApprovalBinding): Promise<TaskView> { return this.call({ op: "approve", ...binding }); }
  executeTask(reference: { taskId: string; revision: number }): Promise<TaskView> { return this.call({ op: "execute", ...reference }); }
}
