# 本地来源与迁移状态

记录日期：2026-10-26。

## 现有成果的来源

- 原仓库：`https://github.com/swordfate3/pi-web-ui.git`。
- 本地原仓库：`/home/fate/gitproject/codex_project_v2/pi-web-ui`。
- 本轮复用的隔离工作区：`/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals`。
- 拆分起点：`27326a8cbea8331cac29e6b6b41f98f2b69fa05b`，保留于 `codex/hub-create-pi`。
- 干净 Web 分支：`v1`，独立拆分提交 `eef18b555dbe99f31de9408299751af221daab7b`；这是本地分支，不表示已经发布或替换使用中的扩展。
- 建立分支时，`main...codex/hub-create-pi` 的左右独有提交数量为 `0 16`；未遗漏该时点的 main 提交。

## 已迁入的实现

| 来源 | 新项目中的职责 | 当前状态 |
| --- | --- | --- |
| `hub/`、`bin/pi-web-hub.mjs` | 管理页面、多会话路由、登记、任务状态 | 已迁入；内部协议导入改为 Manager 自有路径 |
| `integrations/runtime-updater/gate/` | 审批、任务存储、受限执行、更新与回退 | 已完整迁入 `gate/`，未部署或启动 |
| `integrations/runtime-updater/pi-runtime/` | 受管 Pi 启动、控制、版本及身份验证 | 已完整迁入 `runtime/`，未安装到生产环境 |
| Hub 与 Pi 共用的协议类型 | 明确版本的契约与兼容测试 | 必要定义已迁入 `protocol/`；旧字段和校验保留 |

逐文件来源、目标、源 SHA-256、当前目标 SHA-256 和是否做过路径适配见
[`migration-inventory.json`](migration-inventory.json)。清单来源固定为提交
`27326a8cbea8331cac29e6b6b41f98f2b69fa05b`。

原包声明 MIT 许可。迁移源码时必须按实际文件保留原有 LICENSE、版权与来源；新增项目的许可和发布元数据在源码落地时明确，不因创建本目录而视为已完成授权整理。

## 不迁入的内容

不复制原仓库 `.git`、`node_modules`、构建缓存、生产配置、SSH 私钥、Token、环境变量文件、用户会话或 Docker 数据卷。测试只使用独立临时状态和自有测试资源。

## 当前证据边界

本目录已包含独立构建和测试配置，Web 也已完成单会话包清理，但这不代表统一 Manager、MCP、原生后端或生产迁移已经完成。原分支的测试结果不能当作新项目的测试结果；新项目的实际命令与限制记录在本项目的 `docs/validation/2026-10-26-independent-packages.md`。原分支的新建 Pi 功能仍有真实 Docker/浏览器验收未完成，详见原仓库 `docs/validation/2026-10-25-hub-create-pi.md`。

Manager 默认版本检查不再把 `swordfate3/pi-web-ui` 当作 Manager 发布源。Gate 的旧仓库和旧入口固定值仍按源文件保留，明确属于未接线的遗留集成；未宣称 Manager 自更新可用，也未放宽来源或身份检查。
