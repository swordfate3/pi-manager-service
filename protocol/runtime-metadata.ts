export type RuntimeMetadata = {
  runtimeId: string;
  sessionId: string;
  leafId: string | null;
  version: string;
  managed: true;
};

/** Display/identity metadata, never proof that a container is authorized for control. */
export function readRuntimeMetadata(value: unknown): RuntimeMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime metadata");
  const v = value as Record<string, unknown>;
  const valid = (item: unknown) =>
    typeof item === "string" && item.length > 0 && item.length <= 256 && !/\p{Cc}/u.test(item);
  if (
    Object.keys(v).sort().join(",") !== "leafId,managed,runtimeId,sessionId,version" ||
    v.managed !== true ||
    !valid(v.runtimeId) ||
    !valid(v.sessionId) ||
    (v.leafId !== null && !valid(v.leafId)) ||
    !valid(v.version)
  )
    throw new Error("Invalid runtime metadata");
  return {
    runtimeId: v.runtimeId as string,
    sessionId: v.sessionId as string,
    leafId: v.leafId as string | null,
    version: v.version as string,
    managed: true,
  };
}
