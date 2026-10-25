// 8 browser pairs * 2 directions * 16.5 MiB = 264 MiB admitted payload.
// This is not a Pi-run limit or an RSS guarantee. The remaining 248 MiB of a
// 512 MiB container also has to cover ws/parser copies, HTTP and the runtime.
export const HUB_LIMITS = Object.freeze({
  browserPairs: 8,
  connections: 128,
  registrationPeers: 64,
  registrationOperations: 32,
  backendProbes: 4,
  websocketCompression: 2,
  httpCompression: 2,
  inFlightBytes: 16 * 1024 * 1024,
  waitingBytes: 512 * 1024,
  waitingMessages: 512,
});
