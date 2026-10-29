# Pi Stack：只维护这一套

这个目录是**部署配置**，不是 Hub 源码。Hub 在 Docker 镜像里运行；镜像由远程 GitHub 的完整提交构建，不挂载本地源码、`dist` 或 `node_modules`，不连接旧部署。

## 启动和停止

```bash
pi-dockerctl up           # 启动 Hub + 阿里云 SSH 隧道
pi-dockerctl status       # 看 Compose 服务和临时 Pi
pi-dockerctl links        # 显示网页地址
pi-dockerctl logs         # 看 Hub 日志
pi-dockerctl logs tunnel  # 看隧道日志
pi-dockerctl down         # 停常驻服务，不删项目和卷
```

在项目目录执行 `pirun`，当前目录就是容器的 `/workspace`。也可以登录 Hub，选目录后点击启动。网页启动的 Pi 在 Hub 停止；终端启动的 Pi 在原终端退出。Hub 停止或升级可能结束网页启动的 Pi，请先保存工作。

不使用包装命令也可以：**在本目录执行 `docker compose up -d`**；没有 `local up`、四角色服务、旧 Hub/Gate 或其他启动入口。`pi` 属于按需 profile，不会随 `up` 启动一个空白会话。

## Hub 到底怎么拉取／更新

源码仓库是 `https://github.com/swordfate3/pi-manager-service.git`。`compose.yaml` 的 `hub.build.context` 是远程 Git URL 加**完整提交号**，Docker 自己取得源码并按 `deploy/compose/Dockerfile` 构建。它不是从本机开发目录构建，也不是 `docker pull` 一个已发布的 Hub 镜像。

```bash
pi-dockerctl version      # 查看当前仓库、跟踪分支、完整提交和镜像标签
pi-dockerctl update       # 查询所记录的远程分支，构建新提交，再更新 Compose
pi-dockerctl update --ref main
pi-dockerctl update --ref <完整提交号>
```

更新前先在 Hub 停止网页创建的 Pi；有活动网页 Pi 时更新会拒绝执行，不强杀生成。终端 Pi 可以继续运行。构建失败不会先停正在运行的 Hub；激活失败会尝试恢复上一镜像，并报告失败。

如果只想重建当前锁定的提交，在本目录执行 `docker compose build hub`，再执行 `docker compose up -d`。这不会自动查询远程分支的新提交。**Hub 更新不等于更新 Pi 或 Web 扩展**：Pi 用 `pirun update pi`，扩展用 `pirun update --extensions`，已运行 Pi 退出重开后使用更新。

## 只有这些位置需要区分

| 位置 | 用途 |
| --- | --- |
| `config/hub.json` | Hub 端口、域名、允许的项目目录、默认目录、SSH 隧道地址 |
| `config/pi.json` | Pi 镜像、截图来源／开关、SSH／bashrc／HF 挂载开关、五个卷名 |
| `pi-models/models.json` | 唯一模型配置，CC Switch 指向这里；改完退出重开 Pi |
| `config/tunnel_ed25519`、`known_hosts` | 隧道专用私钥和主机验证记录，不给普通 Pi |
| `data/hub/` | 登录数据库、会话登记和启动记录；不要手改或初始化 |
| `data/memory/host-id` | 记忆身份，保持原值 |
| `data/screenshots/` | 截图进程的锁、日志和引用计数，不是模型或会话配置 |
| `internal/` | 小型维护脚本和自动生成的运行配置，不是 Hub 应用源码 |
| `archive/` | 原部署与备份，仅归档；启动时不读取 |

改两个 `config/*.json` 后执行 `pi-dockerctl configure`，再执行 `pi-dockerctl up`。`compose.yaml` 是生成结果，不要与 JSON 两边同时修改。不会自动加载宿主或项目 `.env`；代理和 API key 只传允许的已导出环境变量。不要把凭据发到聊天中。

## 截图、数据与权限

QQ 截图从配置的 Windows 目录镜像到**当前项目**的 `.pi-attachments`，Pi 只读；同目录多个 Pi 共用计数，最后一个退出后清理默认附件目录。原始 Windows 截图不删除。

Pi 以 UID/GID `1000:1000` 运行，无 sudo、无 Docker socket。项目文件和五个外部命名卷保留；系统包写进 Pi 镜像，不要指望容器临时系统层持久化。备份必须包含项目、卷以及本目录配置／数据，不能只备份其中一个。

只有可信 Hub 获得 Docker socket，用于创建和停止 Pi。普通 Pi 不获得 Hub 登录数据库或隧道私钥。公网链路是：**手机 → 阿里云 HTTPS → Compose SSH 隧道 → Compose Hub → Pi**。隧道只开放阿里云回环地址，不公开内部 Hub 端口或 Docker socket。

账号在网页修改；忘记密码执行 `pi-dockerctl password`。不要使用 `down -v`、删卷或重新初始化来修复故障。
