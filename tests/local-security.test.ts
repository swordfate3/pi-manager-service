import assert from "node:assert/strict";
import test from "node:test";
import { DUMMY_PASSWORD_HASH, digestToken, hashPassword, newToken, validatePassword, verifyPassword } from "../manager/local-security.ts";
import { ManagerError } from "../manager/validation.ts";

test("password hashes use the fixed bounded scrypt format and verify only the original password", async () => {
  const encoded = await hashPassword("twelve chars!");

  assert.match(encoded, /^scrypt\$N=131072\$r=8\$p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.equal(await verifyPassword("twelve chars!", encoded), true);
  assert.equal(await verifyPassword("twelve chars?", encoded), false);
});

test("unknown-account verification can use a fixed strict-format dummy hash", async () => {
  assert.equal(DUMMY_PASSWORD_HASH, `scrypt$N=131072$r=8$p=1$${"A".repeat(22)}$${"A".repeat(86)}`);
  assert.equal(await verifyPassword("twelve chars!", DUMMY_PASSWORD_HASH), false);
});

test("login verification hashes empty and short submissions before returning an ordinary mismatch", async () => {
  const encoded = await hashPassword("twelve chars!");

  assert.equal(await verifyPassword("", encoded), false);
  assert.equal(await verifyPassword("short", encoded), false);
});

test("hashing rejects concurrent work above two slots with a generic busy status", async () => {
  const first = hashPassword("first password");
  const second = hashPassword("second password");

  await assert.rejects(hashPassword("third password"), (error: unknown) => error instanceof ManagerError && error.status === 429);
  await Promise.all([first, second]);
});

test("password creation validates Unicode character and UTF-8 byte bounds while verification rejects only oversized or mistyped input", async () => {
  assert.doesNotThrow(() => validatePassword("🙂".repeat(12)));
  for (const invalid of ["a".repeat(11), "a".repeat(257), "🙂".repeat(257), 7]) {
    assert.throws(() => validatePassword(invalid as string), (error: unknown) => error instanceof ManagerError && error.status === 400);
  }
  await assert.rejects(hashPassword("short"), (error: unknown) => error instanceof ManagerError && error.status === 400);
  await assert.rejects(verifyPassword("a".repeat(257), DUMMY_PASSWORD_HASH), (error: unknown) => error instanceof ManagerError && error.status === 400);
  await assert.rejects(verifyPassword("", 7 as unknown as string), (error: unknown) => error instanceof ManagerError && error.status === 400);
});

test("password verification fails closed on malformed or oversized encodings without returning plaintext", async () => {
  const password = "twelve chars!";
  const encoded = await hashPassword(password);

  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(password, encoded + "x"), false);
  assert.equal(await verifyPassword(password, encoded.replace("N=131072", "N=2")), false);
});

test("new session tokens are 32 random bytes in base64url and digest as SHA-256 hex", () => {
  const first = newToken();
  const second = newToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(digestToken("token-fixture"), "9d00d1dc64b95da84e304d1251d1e855c80c9886cc729688207f4d1be26692bf");
});

test("session cookies separate local and remote authority and read only one valid matching token", async () => {
  const { readSessionCookie, sessionCookie } = await import("../manager/local-security.ts");
  const token = "A".repeat(43);

  assert.equal(sessionCookie(token, false, 3600), `pi_local_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  assert.equal(sessionCookie(token, true, 3600), `__Host-pi_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`);
  assert.equal(sessionCookie(token, false, 0), "pi_local_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  assert.equal(readSessionCookie(`theme=dark; pi_local_session=${token}`, false), token);
  assert.equal(readSessionCookie(`__Host-pi_session=${token}`, false), undefined);
  assert.equal(readSessionCookie(`pi_local_session=${token}; pi_local_session=${token}`, false), undefined);
  assert.equal(readSessionCookie("pi_local_session=not-a-token", false), undefined);
});

test("login throttle blocks after five failures for fifteen minutes and success clears the record", async () => {
  const { LoginThrottle } = await import("../manager/local-security.ts");
  let now = 10_000;
  const throttle = new LoginThrottle(() => now);
  const key = "127.0.0.1";

  for (let attempt = 0; attempt < 4; attempt++) {
    throttle.allow(key);
    throttle.failure(key);
  }
  throttle.allow(key);
  throttle.failure(key);
  assert.throws(() => throttle.allow(key), (error: unknown) => error instanceof ManagerError && error.status === 429);
  now += 15 * 60 * 1000;
  assert.doesNotThrow(() => throttle.allow(key));
  throttle.failure(key);
  now += 29 * 60 * 1000;
  assert.throws(() => throttle.allow(key), (error: unknown) => error instanceof ManagerError && error.status === 429);
  now += 60 * 1000;
  assert.doesNotThrow(() => throttle.allow(key));
  throttle.success(key);
  assert.doesNotThrow(() => throttle.allow(key));
});

test("login throttle evicts the least recently used key when bounded capacity is exceeded", async () => {
  const { LoginThrottle } = await import("../manager/local-security.ts");
  const throttle = new LoginThrottle(() => 10_000);

  for (let attempt = 0; attempt < 4; attempt++) throttle.failure("oldest");
  for (let index = 0; index < 2048; index++) throttle.failure(`other-${index}`);
  throttle.failure("oldest");

  assert.doesNotThrow(() => throttle.allow("oldest"));
});
