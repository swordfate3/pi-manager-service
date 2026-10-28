import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { bearer, boundary } from "../manager/http.ts";

const credential = "gateway-requester-credential-00000000001";
function request(headers: string[]) {
  const req = new IncomingMessage(new Socket()); req.rawHeaders = headers; req.method = "GET"; req.url = "/api/manager/capabilities"; return req;
}
test("gateway-stripped Basic auth leaves an independently authenticated Manager header", () => {
  assert.equal(bearer(request(["X-Pi-Manager-Token", credential])), credential);
});
test("API clients can still use Bearer without a custom Manager header", () => {
  assert.equal(bearer(request(["Authorization", `Bearer ${credential}`])), credential);
});
test("ambiguous or duplicate Manager credentials fail closed", () => {
  for (const headers of [["X-Pi-Manager-Token", credential, "Authorization", `Bearer ${credential}`], ["X-Pi-Manager-Token", credential, "x-pi-manager-token", credential]]) {
    assert.throws(() => bearer(request(headers)));
  }
});
test("Manager header is bounded and does not relax exact Host or Origin checks", () => {
  for (const value of ["short", "x".repeat(129), "cookie=value", "Bearer "+credential]) assert.throws(() => bearer(request(["X-Pi-Manager-Token", value])));
  const req=request(["Host", "manager.example", "Origin", "https://evil.example", "X-Pi-Manager-Token", credential]);
  assert.throws(() => boundary(req, "https://manager.example"));
});
