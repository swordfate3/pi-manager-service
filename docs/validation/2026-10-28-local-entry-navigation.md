# 本地入口点击返回 403：修复与验证

## 根因

入口的来源边界统一拒绝 `Sec-Fetch-Site: cross-site`，误将从外部页面点击
进入工作台的正常顶层导航当作跨站 API 调用。原验证主要从地址直接进入，
没有覆盖用户在其他页面点击入口的路径。

部署入口旧行为复现：直接 GET 首页返回 200，带 cross-site / navigate /
document 请求头的 GET 返回 403，正文与用户报告相同。临时服务 HTTP 回归
和真实 Chromium 外部链接点击均在修复前得到 `403 !== 200`。

## 最小修改

仅允许 GET `/` 和 `/sessions/` 的顶层 document / navigate 导航通过
cross-site 检查；精确 Host 和 Origin 校验仍保留。API、脚本、iframe、会话
路径、WebSocket 和所有修改操作不获得该例外。启动、停止的 CSRF 校验不变。

## 验证结果

- 本地服务与 UI 测试串行执行：35 项通过，0 失败，0 跳过，含真实 Chromium。
- build（含类型检查）、verify:dist、git diff --check 通过。
- 部署前确认本地工作台无活跃 Pi，仅更新并重启本地工作台用户服务。
- 对实际 `http://127.0.0.1:18403/` 使用真实 Chromium 从另一个站点点击：
  导航请求确有 cross-site，响应 200，默认项目显示 `gitproject / pi_projects`，
  “启动并进入会话”按钮可用。测试没有启动真实 Pi。
- 实际入口跨站 API 请求仍返回 403。
- 源构建与部署构建 SHA-256 相同：
  `4a44f50df1647fb9df3099d89c152bf21bc05b91d42edcd05d5612d76e238f56`。

未改动其他容器或公网链路，未提交或推送代码。Node fetch 会自行设置
Sec-Fetch-Mode，因此导航头复测使用原始 HTTP request 或真实浏览器，避免
将客户端重写后的 cors 请求误当作 navigate 请求。
