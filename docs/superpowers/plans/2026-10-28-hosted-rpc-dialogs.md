# Hosted RPC Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页启动的 Pi 在现有登录下完成标准四类弹窗。

**Architecture:** Manager 读取自己持有的 RPC 标准输出，只提取有界弹窗；认证 API 按实例 generation 与 sessionId 查询和回答。Web v1 检测该 API，在原聊天页渲染，不开放普通 WebSocket 授权。

**Tech Stack:** Node JSONL streams、TypeScript、React、node:test、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-28-hosted-rpc-dialogs-design.md`

## Global Constraints

- 不自动批准，不接管原生 TUI，不写日志、SQLite 或浏览器持久存储。
- 协议 `pi-host-rpc-ui-v1`；行上限 256 KiB、弹窗 32 KiB、八个待处理、回答 4096 字节、两分钟上限。
- 进程、generation、sessionId、请求 ID 一致才允许回答；重复发送不得重复生效。
- 只使用隔离测试目录和合成扩展，不使用生产卷、凭据、项目或模型请求。

### Task 1: Bounded RPC owner

**Files:** Create `manager/local-rpc-dialogs.ts`, `tests/local-rpc-dialogs.test.ts`; modify `manager/local-launcher.ts`.

**Interfaces:** `LocalRpcDialogs(readable, writable)`, `snapshot(sessionId)`, `respond(sessionId, body)`, `close()`; launcher uses generation-scoped lookup and exposes `dialogs(generation, sessionId)` / `respondDialog(generation, body)`.

- [ ] Write failing tests with PassThrough streams: literal confirm request maps to exact `extension_ui_response`; select rejects values not in options; cancellation cannot turn into approval; Unicode framing survives chunk splits; oversized unrelated line does not block next request.
- [ ] Run `node --import ./tests/register-ts.mjs --test tests/local-rpc-dialogs.test.ts`, observe feature-missing failure.
- [ ] Implement minimal bounded parser, session query correlation, deadlines, duplicate-decision fencing and cleanup. Query `get_state` for request binding and before response; standard responses only.
- [ ] Run covering tests and existing `tests/local-launcher-lifecycle.test.ts`; inspect that no dialog text enters LocalStore.

### Task 2: Authenticated instance API

**Files:** Modify `manager/local-service.ts`, `manager/http.ts`; create `tests/local-rpc-api.test.ts`.

**Interfaces:** GET/POST `/api/local/dialogs/<generation>` as defined by the spec, with existing login and X-Pi-Local-Csrf.

- [ ] Write API tests against real temporary workbench and controlled launcher: unauthenticated 401, wrong Origin/CSRF 403, unknown/terminal generation unavailable, exact active request answered once, no raw stdin commands accepted.
- [ ] Run tests and observe routes missing; implement routes with strict body keys and bounded JSON input.
- [ ] Re-run API, authentication and lifecycle regression tests.

### Task 3: Current chat dialog UI

**Files (Web v1):** Create `src/web/src/core/host-rpc-dialogs.ts`, `src/web/src/components/pi-web-ui/host-rpc-dialog.tsx`, `tests/host-rpc-dialogs.test.ts`; modify `terminal-prompt-banner.tsx`.

**Interfaces:** Browser client parses the exact protocol, generation and session identity, uses authenticated same-origin requests and returns explicit unavailable on non-hosted deployments.

- [ ] Write failing protocol tests rejecting unknown methods, oversized fields and malformed envelopes; ensure cancellation/confirm/select/input/editor JSON bodies match host API.
- [ ] Implement client and responsive modal with pure text preview, four widgets and explicit cancellation. Poll while prompt active; abort stale requests and never retry a decision after an uncertain delivery.
- [ ] Run protocol tests, typechecks and browser acceptance with a real isolated Pi. Capture and inspect desktop/mobile screenshots per webui-visual-check.

### Task 4: Delivery and operational boundaries

**Files:** README and `docs/local-workbench.md` in Manager, `docs/terminal-prompts.md` and `docs/development-log.md` in Web, both tracked dist outputs.

- [ ] Build both projects, verify dist and package tests, perform independent review of identity/timeout/authorization boundaries.
- [ ] Record exact supported cases and unimplemented TUI/custom controls; do not claim all extension authorizations work.
- [ ] Update only verified deployment artifacts; preserve existing Pi processes and state. If a running workload prevents safe rollout, report the precise remaining action rather than restarting it.
