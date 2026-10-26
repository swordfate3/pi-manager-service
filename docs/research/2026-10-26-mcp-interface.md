# MCP 管理入口：后续实施依据

核对日期：2026-10-26。本文是后续实施依据，不是已经实现 MCP 的说明。

## 官方资料

- SDK v1 与 v2 的关系：<https://ts.sdk.modelcontextprotocol.io/>
- SDK v2：<https://ts.sdk.modelcontextprotocol.io/v2/>
- HTTP 服务：<https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html>
- 授权：<https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html>
- 旧客户端：<https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html>

官方 SDK 入口提供 v1/v2 文档，服务端包已拆分为 `@modelcontextprotocol/server`，不能直接沿用旧教程的单包导入方式。2026-10-26 通过只读 HTTPS 查询官方 npm 注册表，`@modelcontextprotocol/server/latest` 实际返回 `2.4.0`，要求 Node >=20，依赖 `@modelcontextprotocol/core` 精确版本 `2.4.0` 与 `zod ^4.2.0`。本轮拆包不新增 SDK 依赖；后续实际安装须固定版本并核对完整性，不仅根据文档猜测版本。

注册表记录：<https://registry.npmjs.org/@modelcontextprotocol/server/latest>；当次 tarball 完整性为 `sha512-rgR9yxSaAJ+bcsi/XroT/S2AfPiIWloXAnrdfYSCms9ivVju0ishu/wW0J21Ho6+ZOR1r7RyeRbjiRuF87ix5Q==`。这只记录当次元数据，不等于已下载、验证 tarball 或测试客户端。

## 对本项目的约束

采用独立常驻服务的 HTTP 接口方向，而不是用 Pi 拉起一个同时拥有执行器生命周期的 stdio 子进程。若后续提供 stdio 兼容入口，它只能是连接常驻管理器的客户端桥，不启动或停止管理器。

官方 HTTP 示例把 Host、Origin 和认证检查放在处理器前；SDK 处理器本身不能视为已有认证。本项目还必须把 Agent 的提交/查询权限与管理员审批权限分开，禁止通过 MCP 发出任意执行参数或自我批准。

使用单个持久任务存储和幂等键：MCP 工具返回任务 ID；等待生成、执行、失败和不明结果由管理器记录，而非依赖客户端保持连接。新 SDK 的能力不能替代这些产品层安全约束。

## 必须以真实测试证明

1. 通过官方客户端调用真实 MCP 处理器，验证身份、参数校验、提交、查询及未知工具拒绝；不只测试自写 JSON 包装。
2. Agent 凭据不能审批自己的任务，也不能读取管理员凭据；错误 Host/Origin、无凭据、撤销凭据均拒绝。
3. MCP 客户端结束后，已提交任务仍在管理网页可见；管理器重启后可恢复查询。
4. Pi 更新期间 MCP 连接中断不能让旧任务重复激活；不明结果不得自动重放。
5. 对实际目标 Pi MCP 客户端验证协议兼容；未测客户端不能宣称开箱即用。

原生启动、共享安装激活、扩展管理和执行器封装须另按批准设计落地；SDK 可调用不等于这些管理能力已经完成。

## 目标 Pi 客户端的本机依据

本轮还读取了开发依赖 Pi `1.1.0` 所带的官方 `docs/mcp.md`。该版本文档支持 stdio 和 Streamable HTTP；`pi mcp add` 可通过 URL 与 bearer-token 环境变量配置服务，`pi mcp list` 是真实连接检查入口。后续验收应直接使用隔离 agent 目录里的这些命令验证新管理服务，而不要求用户另装一个负责启动 Manager 的 Pi 扩展。

文档中的用户配置位于 `~/.pi/agent/mcp.json`，项目配置位于受信任项目的 `.pi/mcp.json`；本轮没有写入这些真实文件。只有在 Manager 端点实际实现并通过协议/权限验收后，才给出连接配置，不预先把文档示例当成可用服务。

## 完成阶段重新核对

2026-10-26 再次直接查询官方 npm 注册表，server 和 client 均为 2.4.0，Node 适配器为 `@modelcontextprotocol/node@2.1.2`。三个包已在新建临时开发目录安装，禁用生命周期脚本，不改写现有共享 `node_modules` 或真实 Pi。官方包内 README 和类型声明确认：Node `http` 服务可通过 `NodeStreamableHTTPServerTransport` 接入，必须在 `handleRequest` 前完成 Host/Origin 和应用认证检查；无状态模式使用 `sessionIdGenerator: undefined`，并为每个请求新建协议 server/transport。

当次 client 完整性：`sha512-LgrD2OphHuG12vfKFKz6SOnq7bKHQmhGJIAYdD+MZBn2npHEyry6uD8zvktodtl5CQM85MO0anUyD9JwmUmxww==`。
当次 Node 适配器完整性：`sha512-IIcIqBpr6NCQQs5DgJTgvbSOAw+3iaR/uquqg+e0nXCdudfjPg/80x0TseUnQx14AUAtE4fsJCEpJKPyb6WPVA==`。

下载和 SDK 接口核对仍不是 Manager MCP 完成；实际官方客户端和 Pi 客户端验收完成后另行记录。
