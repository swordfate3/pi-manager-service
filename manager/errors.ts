/** A mutation may have happened, or resource control/termination is unconfirmed.
 * This signal is executor-private. Never serialize its internal cause/message.
 */
export class ExecutionOutcomeUnknownError extends Error {
  constructor() { super("Execution outcome requires independent reconciliation"); this.name = "ExecutionOutcomeUnknownError"; }
}
