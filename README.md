# Pi Manager

独立运行的 Pi 管理服务：**登录 → 选目录 → 启动 Pi → 网页聊天**。配合 [Pi Web UI v1](https://github.com/swordfate3/pi-web-ui/tree/v1) 使用，当前为 `0.1.0` 开发预览版。

推荐使用单账号工作台，普通操作无需申请、审批或管理码。支持 Linux，WSL 只是可选环境。

## 快速开始

| 你的情况 | 使用教程 |
| --- | --- |
| 已有 `pirun`，想在网页选目录、启动聊天 | [单账号工作台](docs/local-workbench.md) |
| 从零用 Docker 部署 Manager | [Docker 部署教程](docs/docker-quickstart.md) |
| 已有 pi-stack，想直接从 GitHub 构建并更新工作台镜像 | [远程源码与 Compose 工作台](docs/remote-compose.md) |
| 需要独立审批、原生 Pi 后端或 MCP | [多角色教程](docs/manager-tutorial.md) |

注意：Docker 入门模板只部署 Manager，不会自动安装 Pi。单账号工作台需要已有可用的 `pirun` 和已启用的 Pi Web 扩展；两种部署方式的配置不能混用。

### 从源码运行工作台

需要 Git、Node.js ≥22.19 和 npm；Docker 启动器还需要 Docker Engine 与 Compose 插件。

```bash
git clone --branch main https://github.com/swordfate3/pi-manager-service.git
cd pi-manager-service
npm ci --ignore-scripts
npm run build
npm run verify:dist
```

按[配置示例](docs/local-workbench.md#配置)创建自己的私有配置文件，再启动：

```bash
node dist/manager/pi-manager-local.mjs --config /absolute/private/local-config.json
```

本机默认打开 `http://127.0.0.1:18403/`，首次设置自己的账号密码。手机访问需另配 [HTTPS 公网入口](docs/local-workbench.md#边界)，不能使用手机的 `localhost`。

## 日常怎么用

1. 登录，点击文件夹选择项目；支持当前层文件／目录名搜索、排序和分页，文件不能作为工作目录。
2. 点击**启动并进入会话**；已有实例点击**打开**。
3. 用完点击**停止**。只关闭网页或完成一轮回答，不会停止 Pi。
4. **账号与退出**可修改账号密码、退出设备。

配套新版 Web v1 时，**网页启动**的 Pi 标准确认、选择、输入和多行编辑可直接在
当前聊天页完成，不增加管理码或电脑端审批。终端启动、自绘终端界面仍使用原交互。
此功能需同时更新 Manager 和 Web；已运行的旧实例不会自动接管。

已安装 [pi-stack 终端适配器](docs/local-workbench.md#pi-stack-终端接入) 时，电脑终端运行 `pirun` 也会显示在首页，标记“终端启动”，可打开但不能从工作台停止。旧容器需退出重开，通用安装不会自动接入。

网页实例正常／异常退出后，Docker 确认已停止或不存在，卡片会在后续刷新中移除；Docker 断连时保留“状态未确认”。这不会删除项目、聊天历史或启动记录，不要删卷或数据库清理列表。

## 启停与更新

**已安装 pi-stack 控制器时**，可以在任意目录使用：

```bash
pi-dockerctl local up        # 启动工作台
pi-dockerctl local status    # 查看状态
pi-dockerctl local links     # 查看入口
pi-dockerctl local down      # 停止工作台
pi-dockerctl local password  # 忘记密码：本机终端重设
```

通用源码部署在服务终端按 `Ctrl+C` 停止，再用原配置启动；不会自带上述控制器。

更新前先保存本地修改、[备份状态](docs/local-workbench.md#sqlite和缓存)，并退出网页启动的 Pi：

```bash
git status --short
git pull --ff-only origin main
npm ci --ignore-scripts
npm run build
npm run verify:dist
```

然后按原部署方式安装新构建、用原配置重启，**不要重新初始化**。仅 `git pull` 不会更新运行中的服务或宿主 `pirun` 脚本；工作台重启可能结束网页 Pi。更新 Manager 不等于更新 Pi／Web 扩展。

## 需要知道

- 账号、登录和实例元数据保存在 `stateRoot/manager.sqlite3`；Pi 配置、扩展和历史仍由原环境保存。
- 公网访问需显式配置 `publicOrigin`，先在本机设置账号；不要公开内层 Hub 或 Docker socket。
- 网页升级／回退 Pi、安装更新扩展尚未开放；版本列表仅供查询。

更多：[登录与备份](docs/local-workbench.md) · [管理员参考](docs/administrator-guide.md) · [Docker 教程](docs/docker-quickstart.md) · [来源与许可](docs/source-provenance.md)

## 许可与商用署名

使用 [MIT](LICENSE)，允许商用与闭源集成。商业及非商业分发均须保留原有版权和许可声明；
推荐标注项目名称与仓库来源，具体见 [商用署名指引](docs/commercial-use.md) 和 [NOTICE](NOTICE)。
标准 MIT 不强制要求网站页脚署名，依赖与素材另遵其各自许可。
