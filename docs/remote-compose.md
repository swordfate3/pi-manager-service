# 从 GitHub 更新 Docker 工作台

这是已有 `pi-stack` 工作台的容器化部署方式：**远程 Git 提交 → Docker 构建 → Compose 工作台 → Pi 容器**。不需要保留本机 Manager 开发仓库，也不使用本机 `dist` 或 `node_modules`。

## 日常使用

完成迁移安装后，在宿主 Linux／WSL 的任意目录执行：

```bash
pi-dockerctl local up       # 启动工作台及内部 Hub
pi-dockerctl local status   # 看 Compose 服务状态
pi-dockerctl local links    # 看实际网页入口
pi-dockerctl local logs     # 看最近日志，避免把含会话内容的日志公开
pi-dockerctl local down     # 停工作台，不删除数据卷
```

终端仍在项目目录执行 `pirun`；网页仍可登录、选目录、启动 Pi、进入聊天。QQ 截图、当前项目目录、原模型配置和 Pi 命名卷不变。旧四角色 Compose 服务不是这个工作台，不会被工作台更新重建。

## 更新和回退

```bash
pi-dockerctl update                     # 更新当前记录的远程分支；首次默认 main
pi-dockerctl update --ref main          # 显式选择 main
pi-dockerctl update --ref <完整提交SHA>  # 指定版本，也可用该方式回到较早提交
pi-dockerctl rollback                   # 恢复上一版镜像，不回滚数据库
```

分支会先解析为确切的 Git 提交，再交给 Docker 远程构建。仅远程已提交／已推送的内容会进入镜像，本机未提交的改动不会上线。下载失败或构建失败不会停止当前工作台；激活失败时尝试恢复原镜像，并如实报告恢复失败，不宣称服务已正常。

**更新工作台会短暂断开网页，也可能结束它持有的网页启动 Pi。** 先完成任务、保存会话并停止网页实例，再更新；终端 Pi 不属于工作台子进程，但可能需要刷新页面重新取得会话链接。更新 Manager 镜像不等于更新 Pi 程序、Pi 镜像或 Web 扩展。

## 什么保存在本机

以下路径以部署根目录 `pi-stack` 为基准：

| 路径 | 内容 |
| --- | --- |
| `workbench.compose.json` | 按本机私有配置生成的工作台 Compose 文件 |
| `local-workbench/config/config.json` | 原始管理员配置：允许目录、端口、域名、状态位置 |
| `local-workbench/config/container-config.json` | 容器使用的派生配置，程序指向镜像内路径 |
| `local-workbench/config/container.json` | 当前镜像、远程提交和上一版镜像记录 |
| `local-workbench/state/` | 原账号、登录、SQLite、会话登记及启动记录 |
| `state/qq-runtime/` | 新启动器共享的截图锁和引用计数，不是截图副本 |
| `scripts/` | 宿主 pirun、控制器和远程更新工具；不包含 Hub 构建产物依赖 |

已有 Pi 数据仍在原命名卷中；项目仍绑定到 `/workspace`。**不要运行 `down -v`，不要重新初始化已有数据库。** 回退跨越数据库格式变更时须遵守对应发布版本的迁移说明；通用镜像回退不保证任意旧版本都可读取新数据库。

## 运行权限和挂载

工作台是受信任的管理程序，需要 Docker socket 才能检查、启动和停止 Pi，权限相当于能管理本机 Docker。它以宿主 UID/GID 运行，使用 Docker socket 的附加组，保留只读根文件系统、`cap-drop=ALL` 和 `no-new-privileges`。这不是对恶意工作台代码的完整隔离，更新来源必须可信。

只有工作台获得管理权限，普通 Pi 仍无 Docker socket。工作台只绑定配置的项目根、必要配置／状态，以及按存在情况加入的 SSH、`.bashrc`、HF token 和 QQ 图片源；不挂整个 `/`、`/home` 或用户 home，不读取 `.env`。凭据不写进镜像、构建参数或仓库。

工作台使用 host 网络以接入当前 Pi Web 端口；使用 host PID 命名空间，让旧终端与容器内新启动器对截图进程和引用计数的判断一致。迁移时只挂本用户现有 QQ 专用临时路径，不挂整个宿主 `/tmp`。已有 SSH 反向隧道仍转发到原工作台端口，公网只暴露登录入口，不能暴露内部 Hub 或 Docker socket。

## 首次迁移

此方式不等于普通四角色 Docker 入门模板。需要先有可用的 pi-stack、Pi 镜像、持久卷和启用 Web 扩展的 Pi；不要把仅部署 Manager 的入门 Compose 当成完整 Pi 环境。

维护者先从远程提交构建 `deploy/stack/Dockerfile`，在独立端口／状态目录验证镜像；再用镜像中的 `deploy/stack/configure.mjs` 生成本机 Compose，安装宿主适配脚本和独立更新工具。保留原配置、数据库及旧服务的备份，停止旧 user service 后启动新 Compose，保持 HTTPS 隧道的原目标端口。首次切换不能让新旧工作台同时打开同一状态目录。

生产镜像必须能追溯到远程提交。开发分支部署会在记录中保留该分支，后续 `update` 继续跟随它；只有确认对应功能已经合并 main 后，才显式执行 `update --ref main`。
