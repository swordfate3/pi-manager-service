import { isIP } from "node:net";

export type RegistrationConfig = { socketPath: string; credentialFile: string };
export type ConnectionSettings = {
  host?: unknown;
  port?: unknown;
  disabled?: unknown;
  publicUrl?: unknown;
  registration?: { socketPath?: unknown; credentialFile?: unknown };
};

/** Never include the supplied value in errors: it may contain a credential. */
export function validatedPublicUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Pi Web public URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Pi Web public URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Pi Web public URL");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function resolveConnectionConfig(settings: ConnectionSettings = {}, env: NodeJS.ProcessEnv = process.env) {
  const portValue = env.PI_WEB_UI_PORT ?? settings.port ?? 3001;
  // Empty settings are invalid, rather than silently broadening/defaulting access.
  if (!/^\d+$/.test(String(portValue))) throw new Error("Invalid Pi Web port");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Pi Web port");
  const host = env.PI_WEB_UI_HOST ?? settings.host ?? "127.0.0.1";
  if (typeof host !== "string" || (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error("Invalid Pi Web host");
  }
  const disabled = env.PI_WEB_UI_DISABLED;
  if (disabled !== undefined && !["0", "1", "true", "false"].includes(disabled)) {
    throw new Error("Invalid Pi Web disabled option");
  }
  const warnings: string[] = [];
  let publicUrl: string | undefined;
  const suppliedUrl = env.PI_WEB_UI_PUBLIC_URL ?? settings.publicUrl;
  if (suppliedUrl !== undefined) {
    try {
      publicUrl = validatedPublicUrl(suppliedUrl);
    } catch {
      warnings.push("Pi Web public URL ignored: use HTTPS without credentials, query or fragment");
    }
  }
  const socketPath = env.PI_WEB_UI_REGISTRY_SOCKET ?? settings.registration?.socketPath;
  const credentialFile = env.PI_WEB_UI_REGISTRY_CREDENTIAL_FILE ?? settings.registration?.credentialFile;
  let registration: RegistrationConfig | undefined;
  if (socketPath !== undefined || credentialFile !== undefined) {
    if (
      typeof socketPath === "string" &&
      socketPath.trim() &&
      !socketPath.includes("\0") &&
      typeof credentialFile === "string" &&
      credentialFile.trim() &&
      !credentialFile.includes("\0")
    ) {
      registration = { socketPath, credentialFile };
    } else {
      warnings.push("Pi Web registration disabled: configure both socketPath and credentialFile");
    }
  }
  return {
    host,
    port,
    publicUrl,
    registration,
    warnings,
    autoStart: disabled === undefined ? settings.disabled !== true : disabled !== "1" && disabled !== "true",
  };
}

export function localWebUrl(host: string, port: number): string {
  const browserHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${isIP(browserHost) === 6 ? `[${browserHost}]` : browserHost}:${port}/`;
}
