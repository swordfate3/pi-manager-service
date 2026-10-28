# Hub 创建 Pi 容器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能在 Hub 管理流程中选择允许目录，提交创建请求并由独立管理员在网页批准。

**Architecture:** 沿用四角色和现有任务 CAS/审批绑定，扩展已存在 Docker 后端与安全目录选择；不由聊天进程持有 Docker socket。保留静态工作区、禁用后端及 CLI 兼容。

**Tech Stack:** Node >=22.19.0、TypeScript、Node HTTP/Unix socket、Docker Engine API、现有 Vite 分发。

**Spec:** docs/superpowers/specs/2026-10-27-hub-create-pirun-design.md

## Global Constraints

- 不停止、修改或读取生产三个 Pi 的会话与凭据；不部署生产，不推送，不提交无关教程改动。
- 独立管理员网页审批必须保留，申请者不能自我批准；chat/public/Pi 不接触 Docker socket。
- 配置可移植，不写死 /home/fate、gitproject、pi_projects、域名、私人镜像 ID 或凭据。
- 普通 Pi UID/GID1000:1000、cap-drop ALL、no-new-privileges、持久化数据不删除。
- 使用 apply_patch 编辑文件；先 RED 再 GREEN，子代理不得启动下级代理。

## Task 1: 安全动态目录选择与网页审批

**Files:** 新建 manager/workspaces.ts 与 tests/manager-workspaces.test.ts；修改 manager/config.ts、manager/api.ts、manager/executor/{engine,client,docker-adapter,native-adapter}.ts、manager/{service,admin-service,ui}.ts 及相关测试。若需新增方法应保持旧调用兼容。

**Interfaces:** 在 ExecutorConfig 新增可选 workspaceBrowser 策略，包含 home 和 defaultRoot；根目录来自已配置后端的 workspaceRoots。新增认证后目录查询，输入 root/path 只能是管理员根 ID 和相对路径。新建请求允许旧 workspace 字符串或 {root,path}，内部保存固定选择并复用审批 requestHash。MCP 没有审批方法，不必新增目录工具。

- [ ] RED：以真实临时目录和真实 TaskEngine/HTTP 覆盖查询目录、选择深层项目、拒绝 Home 外根与链接/点段/私有目录、匿名/申请者审批失败、审批前无执行、重复请求返回同 ID。示例输入 `{root:'projects',path:'demo/sub'}`，示例拒绝 `{root:'projects',path:'../private'}`。
- [ ] GREEN：实现目录策略与规范化解析，查询最多返回 200 个目录，非目录不返回，不返回宿主绝对路径或原始 IO 错误。创建、审批和执行重新验证目录，不对目录自动写入。
- [ ] GREEN：管理页提供浏览、选择、回到根/上级，保持无浏览策略的下拉列表；管理员网页核对任务并批准执行。退出登录清空目录/审批数据；过期异步响应不能覆盖新登录状态。
- [ ] 验证 focused tests、typecheck。报告 RED/GREEN、改动文件和未解决事项；不提交、不构建 dist、不修改生产。

## Task 2: 可配置普通 Pi Docker 启动环境

**Files:** manager/backends/docker.ts、独立 runtime-profile 模块、manager/config.ts、tests/docker-web-profile.test.ts、新增启动模板测试、配置说明。

**Interfaces:** 只接受管理员配置中的固定模板；请求不能传 env/mount/image/command。保持旧 Docker 配置和严格 owned 检查，扩展的挂载和环境必须进入 policy hash 与容器检查。

- [ ] RED：构造普通 Pi 固定环境模板，验证镜像/挂载/环境进入创建请求和归属核对；改动挂载或添加 Docker socket 导致拒绝，前端注入配置不被接受。
- [ ] GREEN：保留每实例持久 home，按固定名单挂程序/模型/Web；登记和 stop/start 使用原精确身份；不从宿主环境隐式读取凭据。
- [ ] 测试登记就绪、停止恢复、生产配置隔离。QQ 生命周期若未完成明确记入验收缺项，不能宣称全部完成。

## Task 3: 真实隔离验收与部署说明

**Files:** 新建 integration-tests/hub-create-pi、docs/validation/2026-10-27-hub-create-pirun-progress.md 和部署说明，按需新增可选 Compose 配置但不激活生产。

- [ ] 新测试项目仅挂临时目录/卷，使用指定测试 provider；真实 HTTP 提交、网页管理员审批 API、创建容器、登记、stop/start 并确认数据保留。
- [ ] 对比生产容器 ID/StartedAt/RestartCount 未变化；清理仅本次测试资源。
- [ ] 更新构建产物并运行 npm run check、相关回归；审阅权限、路径、幂等和失败恢复。
- [ ] 只有达到验收目标才能报告可部署；否则列出精确阻碍与本轮已通过项，不上线或暗示已完成。
