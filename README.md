# Pi Manager

独立于 Pi 进程的管理服务项目。当前包已提取原 Hub 的多会话入口、登记、管理页面，以及 Gate/Pi runtime 的受控执行源码；它可以在零个 Pi 的情况下初始化并启动 Hub。

**当前状态：完成阶段 2 的独立源码与分发提取，阶段 3 的私有基础模块正在验收，尚未完成统一 Manager 产品。** 现有 Hub CLI 可运行，但这不是新的进程主管；Gate/runtime 源码不会由 CLI 自动部署或启动。新增持久任务存储及原生 Pi 生命周期库；它们尚未接入管理网页、任务执行器或 CLI。本包没有 MCP 服务、扩展管理任务或生产迁移逻辑，不应替代现有部署。

## 构建与 CLI

需要 Node `>=22.19.0`。开发环境可以复用本机已安装的依赖，但分发只声明运行时依赖 `ws`，不包含开发用 `node_modules` 链接。

```bash
npm run build
node dist/hub/pi-web-hub.mjs --help
node dist/hub/pi-web-hub.mjs init --config /tmp/pi-manager/config.json --port 0
node dist/hub/pi-web-hub.mjs serve --config /tmp/pi-manager/config.json
```

打包安装后，等价入口名为 `pi-manager`，命令仍是原有的 `init`、`serve`、`issue`、`revoke`、`pair` 和 `revoke-management`。`init` 会独占创建私有配置及状态目录；不要把真实生产配置、凭据或状态复制到测试目录。

构建输出是 `dist/hub/pi-web-hub.mjs`。`dist/build-manifest.json` 绑定打包后仍存在的 Manager、Gate 和 runtime 可执行源码及构建输出；它有意排除测试、锁文件和 TypeScript/Vite 开发配置，因此解压真实 tarball 后仍可运行 `verify:dist`。验证命令：

```bash
npm run typecheck
npm run verify:dist
npm run test:package
npm run test:unit
npm run test:gate:offline
npm run test:runtime:offline
```

临时端口和 Unix socket 覆盖单独运行：

```bash
npm run test:socket
npm run test:gate:socket
```

这些测试只应使用临时配置和临时状态。真实 Docker/浏览器验收保留在 `integration-tests/runtime-updater/`，必须按原有显式环境变量启用；普通测试不会调用生产 Docker。

## 当前可用边界

- Hub CLI 可以独立初始化和启动；零个 Pi 时管理页面和空会话 API 可用。
- 已提取的 Hub 可以签发/撤销单会话登记凭据、接受现有兼容 Pi Web 适配器登记，并提供多会话门户及已有管理页面。
- Gate/runtime 源码和校验工具随包分发，但 CLI 不会自动启动、部署或编排它们；遗留更新来源默认未配置。
- 浏览器中的聊天仍由独立的 Pi Web 扩展负责。不安装 Manager，也能使用单会话 Web 扩展。

## 开发中的管理基础模块

`manager/task-store.ts` 保存具有请求者、幂等键、修订号和八种状态的任务，提供独占写入、原子持久化和显式崩溃恢复。执行结果不明的任务恢复为 `unknown`，不会自动重放。当前尚没有网页审批 API 或执行器把任务转成生命周期动作。

`manager/backends/native.ts` 是只供受信本机调用的内部库。管理员固定 Pi 可执行路径和允许的工作区根，调用者只能选择根内相对目录。后端只控制自己新建并保留句柄的子进程，不扫描或接管既有 PID，也不从审计文件恢复控制权。默认关闭工具、MCP 和资源自动发现，子进程使用独立 agent 目录及重新构造的环境；这不是已经配置好个人模型和 Web 登记的普通 Pi 工作环境。

原生后端的验收平台仅为 Linux/WSL2；没有据此宣称 Windows/macOS 可用。`agent_end` 不等于自动工作已结束，生成测试等待 `agent_settled`，但后者也不是更新激活的互斥屏障。本阶段不提供更新能力。目录白名单只限制启动位置，不限制同 UID 原生 Pi 的宿主文件访问；开放不可信 Agent 管理接口之前，必须先验证实际账户或容器权限隔离。

私有模块的测试使用临时目录和自有进程。实际 Pi 生成验收另行执行，模型部分是确定性测试 provider，不连接真实模型服务：

```bash
node --import ./tests/register-ts.mjs tests/manager-task-store.test.ts
node --import ./tests/register-ts.mjs tests/native-backend.test.ts
node --import ./tests/register-ts.mjs integration-tests/native-lifecycle.test.ts
```

精确通过项目、审查及尚未完成的服务/MCP 边界见[实施与验收记录](docs/validation/2026-10-26-manager-service-progress.md)。不要把这些库的测试命令当作产品启动命令。

## 后续设计目标（本阶段未实现）

- 统一管理受管 Pi 的创建、停止、更新和回退。
- 通过同一任务模型管理扩展安装与更新。
- 提供独立的 MCP 调用入口，将原生后端接入受限执行器，加入 Docker 后端，并完成跨平台隔离验收。
- 形成一个对用户统一、内部维持低权限入口与受限执行器边界的 Manager 产品。

## 文档

- [架构、迁移和验收设计](docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md)
- [本地来源与迁移状态](docs/source-provenance.md)
- [逐文件迁移与 SHA-256 清单](docs/migration-inventory.json)
- [保留的旧 Web/Hub 混合集成测试](integration-tests/legacy-web/README.md)

## 已知边界

- Manager 自身尚无已发布、已审核的版本来源。默认版本状态不访问网络，也不会把旧 Web 仓库当作 Manager 发布渠道；调用者只能显式注入已审核来源。
- `gate/gate/sources.py`、`gate/gate/registry.py` 和 `gate/gate/deploy.py` 保留原实现中的旧 Hub 仓库与入口约束，作为未接线的遗留集成。没有弱化来源检查，也不宣称 Manager 自更新可用。
- Gate/runtime 的真实 Docker 验收没有在普通构建中运行；原生后端当前仅为内部库，其服务接线、Web 登记与跨平台启动仍属于后续阶段。
- 旧 Web/Hub 混合测试已完整保留但不进入默认离线测试；需要跨项目安装式夹具后才能重新执行，不能把保存文件视为通过。

## 本轮不做的事

不停止现有 Hub/Gate，不修改阿里云、隧道、密码或真实会话，不删除旧实现，不推送远程或合并 main。只有后续统一管理服务、后端及隔离验收完成后，才另行安排部署切换。

Pi Web 的 `v1` 是 Git 分支名，不表示发布了一个新版本。对应 Web 包已完成单会话拆分；安装验证、跨包登记与独立运行的实际结果及未运行项目见[拆分验证记录](docs/validation/2026-10-26-independent-packages.md)。两个项目都仍是本地开发成果，没有替换现有部署。
