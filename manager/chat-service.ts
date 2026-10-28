import { readHubConfig } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { keys, record } from "./validation.ts";
import { readPrivateJson } from "./config.ts";
import { provisioningConfig, startEnrollmentBroker } from "./enrollment/server.ts";

/** Chat/registration plane only: no legacy lifecycle or update control sockets. */
export function chatConfig(value: unknown) {
  const config = record(value);
  keys(config, ["port", "stateDir", "runtimeDir"], ["host", "publicUrl", "leaseMs", "managerLinks", "provisioning"]);
  return config;
}

export async function startChatService(configFile: string) {
  const value = chatConfig(await readPrivateJson(configFile));
  const provisioning = value.provisioning === undefined ? undefined : provisioningConfig(value.provisioning);
  const config = readHubConfig(configFile);
  const hub = await startHub(config);
  try {
    const broker = provisioning ? await startEnrollmentBroker(config, provisioning, run => hub.isRunReady(run)) : undefined;
    return { port: Number(new URL(hub.url).port), close: async () => { try { await broker?.close(); } finally { await hub.close(); } } };
  } catch (error) { await hub.close(); throw error; }
}
