type Socket = {
  readonly readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  once(event: "close" | "error", listener: () => void): unknown;
  off(event: "pong" | "close" | "error", listener: () => void): unknown;
};

/** Hub terminates Pi's WS leg, so its ping/pong cannot keep the browser leg alive. */
export function browserHeartbeat(socket: Socket) {
  let unanswered = 0;
  let disposed = false;
  const pong = () => { unanswered = 0; };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    socket.off("pong", pong);
    socket.off("close", dispose);
    socket.off("error", dispose);
  };
  const timer = setInterval(() => {
    if (disposed) return;
    if (socket.readyState !== 1) { dispose(); return; }
    // Count actual probes, not elapsed wall time: an event-loop stall alone
    // must not retire a healthy client before it has a chance to answer.
    if (unanswered >= 3) { dispose(); socket.terminate(); return; }
    unanswered++;
    try { socket.ping(); } catch { dispose(); socket.terminate(); }
  }, 20_000);
  timer.unref();
  socket.on("pong", pong);
  socket.once("close", dispose);
  socket.once("error", dispose);
  return dispose;
}
