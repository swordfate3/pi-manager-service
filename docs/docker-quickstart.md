# 普通用户：用 Docker Compose 部署 Pi Manager

不需要在电脑上先装 Node/npm，不需要 WSL、阿里云或作者的 `pirun`。本教程从仓库构建镜像，配置和任务数据保存在你自己指定的宿主目录。

**先说明能得到什么：** 一个能启动、登录和保存数据的本机 Manager，包括申请者页面、独立管理员页面、会话门户和 MCP。默认没有 Pi 后端，因此创建 Pi 按钮不会自动开放，也不会接管你原来启动的 Pi。不要把这个步骤当成完整的聊天环境安装。

## 1. 准备 Docker

本模板适用于 **Linux + Docker Engine + Compose 插件 + Bash**。WSL Linux 也可，但必须先确保 Docker daemon 能用。这里使用 host 网络，因为当前服务只监听 `127.0.0.1`；不能只换成 bridge 并映射端口。

没有 Docker 时，按 [Docker 官方 Linux 安装说明](https://docs.docker.com/engine/install/) 选择你的发行版；Ubuntu 可使用 [Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)。不要照搬不匹配的系统命令。

```bash
git --version
docker version
docker compose version
```

`docker version` 必须同时显示 Client 和 Server。只有 Client 不够：`cannot connect` 通常是 daemon 未启动或连接目标不对，`permission denied` 则是当前用户无权访问 daemon。在自己安装的、由 systemd 管理的 Linux Engine 上，可检查：

```bash
sudo systemctl status docker --no-pager
sudo systemctl start docker
```

Docker Desktop 管理的 daemon 不用这个 systemd 启动方式。不要为解决权限错误执行 `chmod 666 /var/run/docker.sock`；Docker daemon 权限很大，Docker 用户组同样不是低权限沙箱。下文假设当前终端已经能执行 `docker version`，不需要临时混用 root 所属的数据目录。

## 2. 下载项目，选好数据目录

```bash
PI_MANAGER_REPO="$HOME/pi-manager-service"
git clone --branch main https://github.com/swordfate3/pi-manager-service.git "$PI_MANAGER_REPO"
cd "$PI_MANAGER_REPO/deploy/local"

export PI_MANAGER_DATA_PARENT="$HOME/.local/share/pi-manager-local"
export PI_MANAGER_UID="$(id -u)"
export PI_MANAGER_GID="$(id -g)"
mkdir -p -m 700 "$PI_MANAGER_DATA_PARENT"
```

在**普通用户终端**操作，不要先 `sudo -i`。变量是路径与数字用户 ID，不是 API Key；你可以改仓库和数据目录的名字。选择你自己的私有数据目录，不要使用其他部署正在使用的目录。若目录已存在，先确认归属和权限，不覆盖现有配置。

数据挂载关系：

```text
宿主机：$PI_MANAGER_DATA_PARENT/manager
容器内：/data/manager
内容：配置、两份登录凭据、任务审计、会话登记状态
```

这是 bind mount，不是额外命名卷。容器删除或镜像重建不会自动删除宿主数据，但手动删除这个宿主目录仍会丢数据。Pi 自己的会话／模型／扩展不包含在尚未配置的 Manager 数据里。

## 3. 构建镜像

保持在 `deploy/local` 目录：

```bash
docker compose config --quiet
docker compose build
```

首次构建需要联网下载官方 Node 基础镜像和 npm 依赖；构建时间取决于网络。构建在容器里完成，不使用宿主 `node_modules`。不要把代理密码或 Token 加到 Dockerfile、build args 或镜像中。

默认基础镜像为固定版本 `node:24.22.1-bookworm-slim`，不是 `latest`。需要锁定镜像摘要时，可在构建前将 `PI_MANAGER_NODE_IMAGE` 设为你已核验的 `node:<版本>@sha256:<摘要>`。版本标签并不等于不可变摘要。

## 4. 只在第一次初始化

```bash
docker compose run --rm --no-deps manager init \
  --directory /data/manager \
  --chat-origin http://127.0.0.1:18200 \
  --public-origin http://127.0.0.1:18201 \
  --admin-origin http://127.0.0.1:18202
```

看到 `"initialized":true` 才继续。它会在宿主数据目录下面新建 `manager`，不能对已有的 `manager` 重复 init。这条命令不启动长期服务，`--rm` 只删除临时容器，不删除数据。

**端口被占用？** 首次初始化时同时改上面三个端口，例如 `18400 / 18401 / 18402`，后续浏览器也使用新端口。host 网络没有 `ports:` 映射，不要只改 Compose 的端口。已有数据需要停服务后同步修改 `chat.json` 的 `port`、`public.json`／`admin.json` 的 `port`、`origin` 及 `chatOrigin`；不要删数据重新初始化来换端口。

## 5. 后台启动，打开页面

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=60 manager
```

日志出现 `"ready":true` 表示主管完成服务就绪检查；`ps` 随后会显示健康检查结果。如果反复 restarting，先看日志，不要重复 init。

在运行 Docker 的电脑上打开：

| 地址 | 做什么 |
| --- | --- |
| `http://127.0.0.1:18200/sessions/` | 会话门户，未接 Pi 时为空 |
| `http://127.0.0.1:18201/` | 申请、查询任务 |
| `http://127.0.0.1:18202/` | 管理员审阅、批准 |
| `http://127.0.0.1:18201/mcp` | MCP 接口，不是聊天页面 |

## 6. 取得自己的登录凭据

没有默认账号密码。下面的命令只应在**你自己的可信终端**执行；它会把申请者凭据显示出来，不要录屏或把输出发给 Agent：

```bash
docker compose exec manager node -e \
  'console.log(JSON.parse(require("node:fs").readFileSync("/data/manager/requester-credential.json","utf8")).credential)'
```

把输出填到申请者页面的 `Credential`，点 `Unlock`。

管理员使用另一份凭据：

```bash
docker compose exec manager node -e \
  'console.log(JSON.parse(require("node:fs").readFileSync("/data/manager/administrator-credential.json","utf8")).credential)'
```

把它只填到管理员页面，不提供给 Agent 或 MCP。两份凭据不能混用；管理员页面刷新后需要重新登录。外层反向代理密码也不是这里的凭据。

## 7. 第二天怎么启动、停止、看日志？

新开终端时，先重新设置 Compose 用到的路径和用户 ID：

```bash
cd "$HOME/pi-manager-service/deploy/local"
export PI_MANAGER_DATA_PARENT="$HOME/.local/share/pi-manager-local"
export PI_MANAGER_UID="$(id -u)"
export PI_MANAGER_GID="$(id -g)"
docker compose up -d
```

**不用重新构建，不用重新 init。** 如果此前改过路径，这里保持同样的值。也可自己将这三个不含凭据的变量保存在本目录的 `.env`；这是 Compose 变量替换，不是让 Pi 读取整个宿主环境。

常用命令都在同一个目录执行：

| 命令 | 效果 |
| --- | --- |
| `docker compose ps` | 查看本套容器状态 |
| `docker compose logs -f --tail=60 manager` | 跟随日志，Ctrl+C 只退出日志查看 |
| `docker compose stop` | 停服务，保留容器和宿主数据 |
| `docker compose start` | 启动已停止的容器 |
| `docker compose restart manager` | 重启 Manager，不更新代码 |
| `docker compose down` | 删除本套容器，保留宿主 bind 数据 |
| `docker compose up -d` | 创建／启动本套容器 |

重启策略是 `unless-stopped`：Docker daemon 重启后通常恢复未手动停止的服务；你主动 stop 的不会因此自动重开。不要用 `docker system prune --volumes` 当作日常停止命令。

## 8. 备份和升级

备份前先停止 Manager，避免复制正在写入的任务：

```bash
docker compose stop
PI_MANAGER_BACKUP="$HOME/pi-manager-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
(umask 077; tar -C "$PI_MANAGER_DATA_PARENT" -czf "$PI_MANAGER_BACKUP" manager)
docker compose start
```

归档包含凭据，必须私下保存，不能提交 Git 或上传公开网盘。恢复时先停服务，解压到**新建的私有目录**，不要覆盖一个仍在使用的数据目录；然后把 `PI_MANAGER_DATA_PARENT` 指向恢复后的父目录。容器路径仍保持 `/data/manager`，同一用户 ID 和兼容配置版本下可复用。

更新 Manager 源码和镜像：

```bash
cd "$HOME/pi-manager-service"
git status --short
git pull --ff-only
cd deploy/local
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=60 manager
```

先检查本地改动、阅读更新说明并备份；有未处理改动时不要继续拉取覆盖。构建失败就停在这里，不重建运行容器。构建成功后的 `up -d` 会重建服务，网页短暂断连；数据目录保持不变，**不要 init**。涉及配置格式迁移时按版本说明处理，不假设任何版本均兼容。这不会更新 Pi 或 Web 扩展。

## 9. 想让它创建独立的 Pi 容器？

那是下一层配置，不是 Docker 已启动就自动获得的权限。这个入门模板故意没有 Docker socket、宿主项目挂载或 Pi 镜像。

当前后端能创建／停止／恢复它自己管理的容器，但需要你显式准备：

1. 真正安装了 Pi 和指定入口的镜像，并固定完整 `sha256` 镜像 ID；普通 Node 镜像不能代替 Pi 镜像。
2. `executor.json` 的 `docker` 配置：daemon 身份、socket、宿主路径坐标、状态目录、允许根目录和预配置项目；`native` 必须是 `null`。
3. 将申请者、管理员、执行器、会话门户实际分离为不同用户／容器和挂载。只给执行器 Docker 管理权限；只改端口或 HOME 不算隔离。
4. 需要聊天时，另配完整 Web 包、会话登记和真实模型 provider；不会自动继承个人凭据。

精确字段和约束见 [Docker 后端参考](administrator-guide.md#docker-后端)。**不要直接在本入门模板增加 `/var/run/docker.sock` 挂载**：本模板内的四个进程同 UID，网页进程也可能接触它。当前仓库尚未提供通用的“一键创建 Pi 容器并完成模型设置”发行模板，这个限制不影响你先自行用 Docker 部署 Manager。

## 10. 常见问题

| 现象 | 检查 |
| --- | --- |
| 要我设置 `PI_MANAGER_DATA_PARENT` | 回到第二／第七节 export；变量不会跨新终端保留 |
| `bind source path does not exist` | 先 mkdir 私有父目录；Compose 不代替你创建 root 所属目录 |
| `EACCES` | 用户 ID 与目录所有者是否匹配？是否曾用 root 创建目录？只修复本次数据目录，不递归改整个 Home |
| init 说目录已存在 | 已经初始化，用 up；若只是失败残留，先备份并查明原因，不直接删除 |
| restarting／启动超时 | 看 logs，检查端口冲突、配置权限、内存和 init 是否成功 |
| 健康检查失败 | healthcheck 只探测申请者首页，结合 ready 日志与其他入口检查，不等于模型健康检查 |
| 浏览器打不开 | 在 Docker 所在 Linux 上测试；手机的 localhost 是手机自身，Windows/WSL 转发也不在此模板保证范围内 |
| 门户空／创建按钮不可用 | 默认没有 Pi 后端，见第九节；不是凭据错了 |
| 想装 Node／Python／编译工具 | 这个是 Manager 镜像，不是 Pi 开发环境镜像 |

该示例只面向可信本机，不应裸露到公网或让不可信 Agent 执行代码。要手机访问，另配 HTTPS、安全网络和精确 Origin，不是简单改监听成 `0.0.0.0`。

返回 [主教程](../README.md) · [管理员参考](administrator-guide.md)
