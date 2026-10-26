import { readHubConfig } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { keys, record } from "./validation.ts";
import { readPrivateJson } from "./config.ts";

/** Chat/registration plane only: no legacy lifecycle or update control sockets. */
export async function startChatService(configFile: string) {
  keys(record(await readPrivateJson(configFile)), ["port", "stateDir", "runtimeDir"], ["host", "publicUrl", "leaseMs"]);
  const hub = await startHub(readHubConfig(configFile));
  return { port: Number(new URL(hub.url).port), close: () => hub.close() };
}
