import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ManagerError, requireThat } from "./validation.ts";

const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 64;
const PASSWORD_HASH = /^scrypt\$N=131072\$r=8\$p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const DUMMY_PASSWORD_HASH = `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${"A".repeat(22)}$${"A".repeat(86)}`;

type ThrottleEntry = { failures: number; blockedUntil: number };

let activeHashes = 0;

export function digestToken(raw: string): string {
  requireThat(typeof raw === "string");
  return createHash("sha256").update(raw).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function sessionCookieName(secure: boolean): string {
  requireThat(typeof secure === "boolean");
  return secure ? "__Host-pi_session" : "pi_local_session";
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  requireThat(typeof token === "string" && Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds >= 0 && maxAgeSeconds <= 2_147_483_647);
  const name = sessionCookieName(secure);
  requireThat(maxAgeSeconds === 0 || SESSION_TOKEN.test(token));
  const value = maxAgeSeconds === 0 ? "" : token;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function readSessionCookie(header: string | undefined, secure: boolean): string | undefined {
  requireThat(header === undefined || typeof header === "string");
  const name = sessionCookieName(secure);
  if (header === undefined || header.length > 8192) return undefined;
  let token: string | undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 1 || part.slice(0, equals).trim() !== name) continue;
    if (token !== undefined) return undefined;
    const candidate = part.slice(equals + 1);
    if (!SESSION_TOKEN.test(candidate)) return undefined;
    token = candidate;
  }
  return token;
}

export class LoginThrottle {
  readonly #entries = new Map<string, ThrottleEntry>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    requireThat(typeof clock === "function");
    this.#clock = clock;
  }

  allow(key: string): void {
    const entry = this.#touch(key);
    if (entry && entry.blockedUntil > this.#clock()) throw new ManagerError(429);
  }

  failure(key: string): void {
    const entry = this.#touch(key) ?? this.#add(key);
    entry.failures++;
    if (entry.failures >= 5) entry.blockedUntil = this.#clock() + 15 * 60 * 1000 * 2 ** Math.min(entry.failures - 5, 6);
  }

  success(key: string): void {
    this.#validateKey(key);
    this.#entries.delete(key);
  }

  #touch(key: string): ThrottleEntry | undefined {
    this.#validateKey(key);
    const entry = this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #add(key: string): ThrottleEntry {
    if (this.#entries.size >= 2048) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    const entry = { failures: 0, blockedUntil: 0 };
    this.#entries.set(key, entry);
    return entry;
  }

  #validateKey(key: unknown): asserts key is string {
    requireThat(typeof key === "string" && key.length > 0 && key.length <= 256 && Buffer.byteLength(key, "utf8") <= 1024);
  }
}

function validatePasswordInput(password: unknown, minimumCharacters: number): asserts password is string {
  requireThat(typeof password === "string");
  const characters = Array.from(password).length;
  requireThat(characters >= minimumCharacters && characters <= 256 && Buffer.byteLength(password, "utf8") <= 1024);
}

export function validatePassword(password: string): void {
  validatePasswordInput(password, 12);
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 2) throw new ManagerError(429);
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, DERIVED_KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    activeHashes--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt);
  return `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  validatePasswordInput(password, 0);
  requireThat(typeof encoded === "string");
  const parts = PASSWORD_HASH.exec(encoded);
  if (!parts) return false;
  const actual = await derive(password, Buffer.from(parts[1], "base64url"));
  const expected = Buffer.from(parts[2], "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
