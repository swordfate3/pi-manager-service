# Independent Manager Service — Next Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立拆包验收之后，交付可在零 Pi 时启动、持久保存任务、显式创建和停止原生 Pi 的独立管理服务。本文件是后续计划，不是本轮已经实现的功能记录。

**Architecture:** 保留提取后的 Hub 路由，增加独立服务入口和受限生命周期执行器；网页和后续 MCP 使用同一任务存储。先验收本机原生后端，不把 Docker 遗留执行器或源码复制视为新后端通过。

**Tech Stack:** Node >=22.19.0、TypeScript、现有 Hub 和 Web 登记协议、Pi RPC JSONL。MCP 使用官方 HTTP 服务与授权资料冻结接口后单独实现，不能用 SDK 代替审批策略。

**Spec:** `docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md`，第 4–8 节；研究依据为 `docs/research/2026-10-26-native-pi-lifecycle.md` 与 `docs/research/2026-10-26-mcp-interface.md`。

## Global Constraints

- 管理器先启动，随后才启动 Pi；零个 Pi 运行时也能打开管理页面。
- 本计划不授权生产迁移、真实会话导入、线上服务重启或 Docker 管理操作。
- 管理器不依赖 WSL、用户私有脚本或固定用户名。
- 执行器只控制自己启动并记录身份的进程，不能扫描并接管任意 PID。
- 所有测试隔离 HOME、新旧配置环境变量、状态根和工作目录；临时服务只绑定随机回环端口。
- 显示“看见的实例”不代表“有权控制的实例”。网页登录不自动赋予所有管理动作权限。
- MCP/网页不得传入任意 shell、Docker 参数或管理员批准凭据。
- Docker、共享安装更新/回退、扩展管理和 MCP 属于后续独立验收；未实现能力明确返回 unavailable。

## Task 1: 持久任务及独占写入

**Files:** 新建 `manager/task-store.ts`、`manager/contracts.ts`、`tests/manager-task-store.test.ts`。

**Interfaces:** `TaskStore.open(root)`、`submit({key, requester, target, action, payload})`、`get(id)`、`transition(id, expectedState, nextState)`、`close()`。任务包含 `id`、`requester`、目标身份、动作、精确请求、状态、时间、结果；状态集合固定为设计第 6 节列出的八个值。存储通过私有文件、原子替换和独占写入锁持久化，不使用不受控共享目录。

- [ ] 首先写实际临时文件测试并观察 RED；同幂等键相同请求返回原任务，不同请求拒绝。

```ts
const first = await store.submit(request);
assert.equal((await store.submit(request)).id, first.id);
await assert.rejects(store.submit({ ...request, action: "stop" }));
await store.close();
const reopened = await TaskStore.open(root);
assert.equal((await reopened.get(first.id)).state, "pending_approval");
```

- [ ] 实现并测试第二写入者拒绝、崩溃后可检测恢复、不明执行结果不自动重放、非法状态迁移拒绝；私有目录 0700、文件 0600。禁止记录凭据内容。
- [ ] 运行 `node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts`，通过后提交本任务文件和准确测试报告。

## Task 2: 原生 Pi 受管生命周期

**Files:** 新建 `manager/backends/native.ts`、`manager/process-identity.ts`、`tests/native-backend.test.ts`、`integration-tests/native-lifecycle.test.ts`。

**Interfaces:** `NativeBackend.create({instanceId, workspace, piExecutable, agentDir})` 返回受管身份；`stop(instanceId)`、`inspect(instanceId)` 只接受存储中的身份。配置由管理员给出可执行路径和允许工作区根，前端仅选择根内的相对目录。启动使用无 shell 的固定参数数组，独立 agent 目录；登记沿用版本化 Web 协议。

- [ ] 先验证未实现时 RED。真实临时进程测试：创建、检查、关 stdin 有序退出；无 Pi 时 API 报空列表，停止 Pi 不终止管理器。
- [ ] 写并运行目录穿越、根外符号链接、冒名 PID、重复停止、可执行文件缺失、启动失败/超时测试；失败不得遗留自有进程。
- [ ] 用实际开发 Pi 和确定性测试 provider 在独立工作区跑一次 RPC 创建/生成/停止。仅进程替身通过不得称为真实 Pi 验收。
- [ ] 记录 `agent_end` 与 `agent_settled` 的区别；本任务不加入更新能力，不能从一个“空闲”快照推断可以安全激活更新。
- [ ] 运行上述两个测试文件并提交，清楚记录仅已测平台；Windows/macOS 不从 Linux 结果推断通过。

## Task 3: 独立入口与管理网页任务闭环

**Files:** 新建 `manager/service.ts`、`manager/main.ts`、`manager/config.ts`、`tests/manager-service.test.ts`，调整 `package.json`、构建入口和 `hub/launch-portal.ts`。

**Interfaces:** 一个用户入口初始化/启动服务，内部使用任务存储和受限原生执行器。`POST /api/manager/tasks` 提交，`GET /api/manager/tasks/:id` 查询；管理员审批走独立权限并绑定任务精确内容，不能复用会话登记或 Agent 凭据。旧 Hub 路由契约保持兼容。

- [ ] 先以真实 HTTP 写 RED：零 Pi 页面可用、创建任务返回持久 ID、未批准不启动、Agent 自我批准 403、非法 Origin/Host 拒绝。
- [ ] 实现网页选择管理员允许的目录、提交/批准/状态查询、明确不可用能力；不允许页面提交可执行路径或 shell。
- [ ] 服务重启后查询任务仍可用，`unknown` 任务不自动重放。管理网页与 Pi Web 聊天页面职责明确。
- [ ] 执行桌面与手机视口的实际浏览器检查，并独立运行真实 Pi 的创建→登记→聊天→停止闭环。仅 DOM 断言不能替代截图检查。
- [ ] 重新构建、校验分发、隔离打包安装后提交；不覆盖旧 `pi-manager` 入口之前保留过渡命令兼容性测试。

## Task 4: 下一阶段 MCP 与管理能力冻结

**Files:** 更新 `docs/research/2026-10-26-mcp-interface.md`，新建 MCP/双后端/安全更新的独立实施计划及契约夹具，不在本任务塞入未验收的占位接口。

- [ ] 开工当天核对官方 SDK 的 HTTP、授权和旧客户端文档，固定实际依赖版本、来源与完整性。Node HTTP 适配、Host/Origin、Bearer 验证和 scope 必须逐项落实；`authInfo` 的传递不等于已认证。
- [ ] 冻结 MCP 的只读查询与受限任务提交 schema：返回同一持久任务 ID，不提供审批自身任务或任意命令工具。
- [ ] 计划必须包含官方客户端和真实 Pi MCP 客户端的连接/断开验收，以及断开后网页仍可查询原任务。
- [ ] 单独编写 Docker 后端隔离验收、扩展管理的来源/安装锁、共享 Pi 安装安全激活与兼容回退计划。运行中的生成必须通过 settled 与输入互斥屏障等待，不能只看一次 idle。
- [ ] 评审 Task 1–3 的源码和证据后再更新产品可用状态；本计划完成仍不意味着全部 Manager 设计完成。

## 自审与交付边界

本计划覆盖设计阶段 3 中的持久服务及原生创建闭环；双后端、MCP 和完整更新/扩展管理的实现仍需后续独立计划。本轮拆包报告必须保留这些缺口。代码步骤均在独立开发分支和临时状态执行，不更换当前生产服务。
