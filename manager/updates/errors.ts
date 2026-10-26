/** Public-safe categories: never retain transport errors, paths, URLs or causes. */
export type CatalogErrorCode = "package-not-approved" | "invalid-version" | "invalid-query" | "metadata-invalid" | "registry-unavailable";
const catalogMessages: Record<CatalogErrorCode, string> = {
  "package-not-approved": "Package is not administrator approved", "invalid-version": "Exact stable version required",
  "invalid-query": "Invalid or expired catalog query", "metadata-invalid": "Official release metadata invalid",
  "registry-unavailable": "Official registry unavailable",
};
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode) { super(catalogMessages[code]); this.name = "CatalogError"; this.code = code; }
}

export type StageErrorCode = "release-invalid" | "package-not-approved" | "engine-unsupported" | "node-incompatible" |
  "root-unsafe" | "writer-busy" | "stage-exists" | "download-failed" | "integrity-mismatch" |
  "archive-invalid" | "resource-limit" | "manifest-mismatch" | "stage-io" | "invalid-installation";
export class StageError extends Error {
  readonly code: StageErrorCode;
  constructor(code: StageErrorCode) { super(`Artifact staging refused: ${code}`); this.name = "StageError"; this.code = code; }
}
