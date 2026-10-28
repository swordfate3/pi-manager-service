# 本地工作台交付验证（2026-10-27）

## 交付范围

本机可信用户入口：选择已有项目目录，点击“启动并进入会话”，由原 pirun
启动 Docker Pi，待该实例的精确会话就绪后自动进入。不要求用户输入令牌、
实例名称或跳转独立审批页面。不改动阿里云、Caddy、DNS、隧道或既有四角色
Manager 部署；不提交或推送现有脏工作树。

本地入口为 `http://127.0.0.1:18403/`，内部聊天端口为 18404，均只监听
127.0.0.1。默认项目为 `/home/fate/gitproject/pi_projects`，可在配置的
`gitproject` 根下选择其他现有目录。部署路径是本机配置，不是程序核心常量。

## 实际端到端验收

使用真实 Chromium、原 pirun、Docker Pi 和现有持久化环境执行，未发送模型
提示词。最终报告 `/tmp/pi-local-accept-WjUgVxqM/result.json` 的
`completed` 为 true，覆盖：

- 默认目录、点击目录即选择、一次点击启动，无手动凭据或审批页面。
- 新 Pi 登记及精确 `b2-…` 会话路由就绪，浏览器自动进入该会话。
- 同源 WebSocket 收到 `state_sync`。
- 原五个持久卷、工作区、UID 1000、cap-drop、no-new-privileges、只读
  bashrc 和截图挂载保留；普通 Pi 无 Docker socket。
- 桌面和 390px 手机宽度布局，以及浏览器停止确认和实际停止。
- 原有基线容器的 ID、运行状态、启动时间和重启次数均不变。

仅验证截图挂载及原桥接生命周期逻辑，没有宣称重新触发真实 QQ 截图。
手机宽度测试不是物理手机或公网验收。

验收 Pi 已全部停止，五个专用测试项目和测试记录已可恢复地归档到：
`/home/fate/docker_files/pi-stack/backup/local-workbench-acceptance-2026-10-27T15-36-45-514Z`。
没有删除共享卷。归档后本地工作台实例列表为空。

## 自动化证据

- 单元套件：576 项，573 通过，3 跳过，0 失败。
- 最终 UI 专项：28 项通过，含真实临时服务与 Chromium。
- 分发/包测试：26 项通过。
- pirun 宿主 Hub 模式：16 项通过。
- 最后代码复查补充：代理响应头已发送后发生中断，不再重复写响应头；
  新增回归测试先失败后通过，最终本地 HTTP/服务测试 5 项通过。
- 最后修复后完整 build（含类型检查）、verify:dist、git diff --check 通过。

最后修复仅涉及响应错误出口；完整真实 Docker/浏览器验收在此修复前执行，
修复后重新构建、执行服务专项测试，并重新部署检查本地状态和监听。

## 部署与操作

- 配置：`/home/fate/docker_files/pi-stack/local-workbench/config/config.json`
- 状态：`/home/fate/docker_files/pi-stack/local-workbench/state/`
- 用户服务：`/home/fate/docker_files/pi-stack/systemd/pi-local-workbench.service`
- 文档：`docs/local-workbench.md`，部署时同步到栈的 docs 目录。
- 命令：`pi-dockerctl local up|down|status|logs|links`。

本地控制器是宿主用户服务，Pi 本体仍通过原 pirun/Compose 在 Docker 中运行。
当前服务已链接并启动，未启用开机自启。正常停止页面中的实例不删除项目或卷。

## 适用边界与后续事项

这是无额外登录密码的可信本机模式，包含精确 Host/Origin 和内部 CSRF 校验，
不是公网管理面，不能直接端口转发上线；也不构成同 UID 或 host-network
恶意进程的隔离。关闭浏览器不停止 Pi。

只读复查未发现已验收路径的关键阻塞；另记录两个未实测的异常恢复风险：
关闭服务超时后子进程仍存活时的状态写入所有权，以及启动器意外退出而容器
残留时的失败状态核对。正常页面停止已实测，不把上述异常恢复视为已完成。
