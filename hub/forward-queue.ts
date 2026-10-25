import type { RawData } from "ws";
import { HUB_LIMITS } from "./limits.ts";

type Payload = RawData | string;
type Socket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Payload, options: { binary: boolean }, callback: (error?: Error) => void): void;
  close(code: number, reason?: string): void;
  terminate(): void;
  once(event: "close" | "error", callback: () => void): unknown;
};
const size = (data: Payload): number =>
  typeof data === "string"
    ? Buffer.byteLength(data)
    : Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.byteLength, 0)
      : data.byteLength;
type Frame = { data: Payload; binary: boolean; bytes: number };

/** One accounted send, plus a bounded unsent FIFO. No pending-send promises. */
export class ForwardQueue {
  private waiting: Frame[] = [];
  private waitingBytes = 0;
  private inFlight: { bytes: number; complete: boolean } | undefined;
  private closed = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private socket: Socket;
  private onSlow: () => void;
  constructor(socket: Socket, onSlow: () => void = () => {}) {
    this.socket = socket;
    this.onSlow = onSlow;
    socket.once("close", () => this.dispose());
    socket.once("error", () => this.dispose());
  }

  enqueue(data: Payload, binary = false) {
    if (this.closed || this.socket.readyState !== 1) return false;
    const bytes = size(data);
    if (bytes > HUB_LIMITS.inFlightBytes) return this.slow();
    if (!this.inFlight && !this.waiting.length && this.socket.bufferedAmount === 0) {
      this.send({ data, binary, bytes });
      return !this.closed;
    }
    if (this.waitingBytes + bytes > HUB_LIMITS.waitingBytes || this.waiting.length >= HUB_LIMITS.waitingMessages)
      return this.slow();
    this.waitingBytes += bytes; // reserve incoming bytes before retaining the frame
    this.waiting.push({ data, binary, bytes });
    this.watch();
    return true;
  }

  snapshot() {
    return {
      inFlightBytes: this.inFlight?.bytes ?? 0,
      waitingBytes: this.waitingBytes,
      waitingMessages: this.waiting.length,
    };
  }

  private send(frame: Frame) {
    const flight = { bytes: frame.bytes, complete: false };
    this.inFlight = flight; // reserve before ws.send, including synchronous callbacks
    this.watch();
    try {
      this.socket.send(frame.data, { binary: frame.binary }, (error) => {
        if (this.closed || this.inFlight !== flight) return;
        if (error) {
          this.slow();
          return;
        }
        flight.complete = true;
        this.drain();
      });
    } catch {
      this.slow();
    }
  }

  private watch() {
    if (!this.poll) {
      this.poll = setInterval(() => this.drain(), 10);
      this.poll.unref();
    }
    if (!this.deadline) {
      this.deadline = setTimeout(() => this.slow(), 5000);
      this.deadline.unref();
    }
  }

  private drain() {
    if (this.closed || this.socket.bufferedAmount !== 0 || (this.inFlight && !this.inFlight.complete)) return;
    this.inFlight = undefined;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    const frame = this.waiting.shift();
    if (frame) {
      this.waitingBytes -= frame.bytes;
      this.send(frame);
    } else {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private slow(): false {
    if (!this.closed) {
      this.dispose();
      this.socket.close(1013, "Slow consumer; reconnect");
      this.onSlow();
      const timer = setTimeout(() => this.socket.terminate(), 250);
      timer.unref();
      this.socket.once("close", () => clearTimeout(timer));
    }
    return false;
  }

  dispose() {
    this.closed = true;
    this.waiting = [];
    this.waitingBytes = 0;
    this.inFlight = undefined;
    clearInterval(this.poll);
    clearTimeout(this.deadline);
    this.poll = undefined;
    this.deadline = undefined;
  }
}
