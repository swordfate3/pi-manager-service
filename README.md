# Pi Manager

独立于 Pi 进程的管理服务项目。当前包已提取原 Hub 的多会话入口、登记、管理页面，以及 Gate/Pi runtime 的受控执行源码；它可以在零个 Pi 的情况下初始化并启动 Hub。

**当前状态：完成阶段 2 的独立源码与分发提取，尚未完成统一 Manager 产品。** 现有 Hub CLI 可运行，但这不是新的进程主管；Gate/runtime 源码不会由 CLI 自动部署或启动。本包没有 MCP 服务、原生 Pi 后端、扩展管理任务或生产迁移逻辑，不应替代现有部署。

## 构建与 CLI

需要 Node `>=22.19.0`。开发环境可以复用本机已安装的依赖，但分发只声明运行时依赖 `ws`，不包含开发用 `node_modules` 链接。

```bash
npm run build
node dist/hub/pi-web-hub.mjs --help
node dist/hub/pi-web-hub.mjs init --config /tmp/pi-manager/config.json --port 0
node dist/hub/pi-web-hub.mjs serve --config /tmp/pi-manager/config.json
```

打包安装后，等价入口名为 `pi-manager`，命令仍是原有的 `init`、`serve`、`issue`、`revoke`、`pair` 和 `revoke-management`。`init` 会独占创建私有配置及状态目录；不要把真实生产配置、凭据或状态复制到测试目录。

构建输出是 `dist/hub/pi-web-hub.mjs`，`dist/build-manifest.json` 绑定当前 Manager、Gate 和 runtime 源码。验证命令：

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

## 产品边界

- 管理器先启动，随后才启动 Pi；零个 Pi 运行时也能打开管理页面。
- 管理会话、创建/停止 Pi、更新/回退 Pi，以及管理扩展安装和更新任务。
- 设计中的 MCP 是管理器的一种调用入口，不是管理器的生命周期宿主；本阶段没有实现该入口。
- 浏览器中的聊天由独立的 Pi Web 扩展负责。不安装管理器，也能使用单会话 Web 扩展。
- 用户管理一个产品；内部保留低权限入口与受限执行器边界，不把容器控制权限直接交给聊天扩展。

## 文档

- [架构、迁移和验收设计](docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md)
- [本地来源与迁移状态](docs/source-provenance.md)
- [逐文件迁移与 SHA-256 清单](docs/migration-inventory.json)
- [保留的旧 Web/Hub 混合集成测试](integration-tests/legacy-web/README.md)

## 已知边界

- Manager 自身尚无已发布、已审核的版本来源。默认版本状态不访问网络，也不会把旧 Web 仓库当作 Manager 发布渠道；调用者只能显式注入已审核来源。
- `gate/gate/sources.py`、`gate/gate/registry.py` 和 `gate/gate/deploy.py` 保留原实现中的旧 Hub 仓库与入口约束，作为未接线的遗留集成。没有弱化来源检查，也不宣称 Manager 自更新可用。
- Gate/runtime 的真实 Docker 验收没有在普通构建中运行；原生后端和跨平台启动仍属于后续阶段。
- 旧 Web/Hub 混合测试已完整保留但不进入默认离线测试；需要跨项目安装式夹具后才能重新执行，不能把保存文件视为通过。

## 本轮不做的事

不停止现有 Hub/Gate，不修改阿里云、隧道、密码或真实会话，不删除旧实现，不推送远程或合并 main。只有后续统一管理服务、后端及隔离验收完成后，才另行安排部署切换。

Pi Web 的 `v1` 是 Git 分支名，不表示发布了一个新版本。本目录只完成 Manager 一侧的提取；干净 Web 包由独立任务处理。
