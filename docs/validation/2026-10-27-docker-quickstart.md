# Docker 入门部署验收（2026-10-27）

## 范围

对应 [普通用户 Docker 教程](../docker-quickstart.md) 和 [本机 Compose 模板](../../deploy/local/compose.yaml)。仅验证可信本机 Manager 部署；未配置 Pi 后端、模型、Web 扩展、公网反向代理或 Docker socket。

没有停止、替换或读取任何现有生产容器、状态卷或凭据。测试使用独立 Compose project、三个随机回环端口和 `mkdtemp` 新建的宿主数据目录；结束后删除本次测试容器与临时数据，保留构建出的入门镜像供复用。

## 实际发现并修正

1. 干净镜像内 `npm ci` 后构建失败：类型检查包括浏览器测试，但 package.json 未声明 `@playwright/test`。已补精确开发依赖及锁文件，并补回归测试；先观察到失败断言，再验证通过。宿主共享 node_modules 曾掩盖这个问题。
2. 第一次运行镜像只复制 `ws`，未包含公开服务需要的 MCP 运行依赖。临时无网络容器重现缺包错误后，改为独立 production-dependencies 阶段按锁文件安装全部生产依赖，再复制进运行镜像；不把开发依赖带入运行镜像。

## 已通过

- `docker compose config --quiet`。
- 新 Dockerfile 中完整 `npm ci`、构建与分发校验；不使用宿主 node_modules，也不复制本机 dist。
- `npm run build`、`npm run check` 和 `git diff --check`。
- `manager-package`、`manager-service-dist` 和新增构建依赖测试：9 通过，0 失败。
- 教程与管理员参考校验：23 个本地链接存在，26 段 Bash 通过语法检查，4 段 JSON 可解析。
- 真实 Compose 隔离启动验收：
  - 初始化成功；重复初始化被拒绝，原凭据保持不变。
  - 凭据文件权限 0600，宿主新建文件 UID 与操作用户匹配。
  - 容器非 root、只读根文件系统、cap-drop ALL、no-new-privileges，且没有 Docker socket 挂载。
  - `up -d --wait` 返回成功、容器 healthy，日志包含 ready。
  - 三个 HTTP 首页可访问；申请者认证和管理员认证正常，申请者凭据无法登录管理员。
  - 教程中的容器内读取凭据命令有效；输出只由测试内部比对，没有显示到工具日志。
  - Pi 后端和更新能力默认关闭，门户为空，符合教程说明。
  - `down` 后重新 `up`，不 init 即恢复访问，凭据不变。

## 尚未宣称

- 没有实测 Windows 原生、macOS 或 Docker Desktop host networking。
- 未验收通用的分角色生产部署或创建独立 Pi 容器流程。
- 未验收模型回答、手机访问、真实 Pi／Web 登记或版本更新。
- 未做跨版本迁移、备份恢复演练或安全审计。
- 本次修改留在本地；不代表 GitHub main 已包含这些文件或生产服务已升级。
