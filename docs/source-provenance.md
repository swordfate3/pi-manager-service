# 本地来源与迁移状态

记录日期：2026-10-26。

## 现有成果的来源

- 原仓库：`https://github.com/swordfate3/pi-web-ui.git`。
- 本地原仓库：`/home/fate/gitproject/codex_project_v2/pi-web-ui`。
- 本轮复用的隔离工作区：`/home/fate/gitproject/codex_project_v2/pi-web-ui-hub-approvals`。
- 拆分起点：`27326a8cbea8331cac29e6b6b41f98f2b69fa05b`，保留于 `codex/hub-create-pi`。
- 干净 Web 目标分支：`v1`。此分支从上述起点建立，尚未完成源码拆分。
- 建立分支时，`main...codex/hub-create-pi` 的左右独有提交数量为 `0 16`；未遗漏该时点的 main 提交。

## 待迁入的实现

| 来源 | 新项目中的职责 | 当前状态 |
| --- | --- | --- |
| `hub/`、`bin/pi-web-hub.mjs` | 管理页面、多会话路由、登记、任务状态 | 尚未复制或修改 |
| `integrations/runtime-updater/gate/` | 审批、任务存储、受限执行、更新与回退 | 尚未复制或修改 |
| `integrations/runtime-updater/pi-runtime/` | 受管 Pi 启动、控制、版本及身份验证 | 尚未复制或修改 |
| Hub 与 Pi 共用的协议类型 | 明确版本的契约与兼容测试 | 尚未拆分 |

原包声明 MIT 许可。迁移源码时必须按实际文件保留原有 LICENSE、版权与来源；新增项目的许可和发布元数据在源码落地时明确，不因创建本目录而视为已完成授权整理。

## 不迁入的内容

不复制原仓库 `.git`、`node_modules`、构建缓存、生产配置、SSH 私钥、Token、环境变量文件、用户会话或 Docker 数据卷。测试只使用独立临时状态和自有测试资源。

## 当前证据边界

创建本目录不代表旧功能已经迁移或通过验收。原分支的测试结果不能当作新项目的测试结果；原分支的新建 Pi 功能仍有真实 Docker/浏览器验收未完成，详见原仓库 `docs/validation/2026-10-25-hub-create-pi.md`。

本轮重新检查了 README 的 2 个本地链接、3 份新文档的尾部空白和代码围栏，均通过。Web 的 `just check` 中 TypeScript 检查通过；Biome 仍因未修改的 `e2e/web-interactions.browser.ts` 导入排序和格式两项错误退出（另有 36 warnings、7 infos）。这不是新项目的测试结果，也不宣称原仓库全检查通过。仅文档变更，未运行程序构建、浏览器或 Docker 验收。
