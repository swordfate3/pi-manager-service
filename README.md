# Pi Manager

独立运行的 Pi 管理服务，配合 [Pi Web UI v1](https://github.com/swordfate3/pi-web-ui/tree/v1) 提供浏览器聊天。当前为 `0.1.0` 开发预览版。

已有可用的 Docker `pirun`，推荐使用**单账号工作台**：登录 → 选目录 → 启动并进入会话。普通操作不需要申请、审批或管理码。

## 快速开始

| 你的情况 | 使用教程 |
| --- | --- |
| 已有可用的 `pirun`，想用网页启动、选择工作区 | [单账号工作台](docs/local-workbench.md) |
| 第一次用 Docker 部署 Manager | [Docker 从零部署](docs/docker-quickstart.md) |
| 需要独立申请／审批、原生 Pi 后端或 MCP | [多角色完整教程](docs/manager-tutorial.md) |

Docker 入门模板只启动 Manager，不会自动安装 Pi、接管现有容器或复制模型凭据。单账号工作台需要已有可用的启动器和启用的 Pi Web 扩展；两种部署方式不要混用配置。

### 从源码运行工作台

需要 Linux、Git、Node.js ≥22.19 和 npm；Docker 启动器还需要 Docker Engine 与 Compose 插件。WSL 是可选运行环境，不是产品要求。

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

本机默认入口为 `http://127.0.0.1:18403/`。首次设置自己的账号密码；已有账号直接登录。配置了 HTTPS 公网域名时，请使用配置中的域名，不能用手机的 `localhost` 代替电脑。

## 日常怎么用

1. 登录工作台，点击文件夹选择工作目录。
2. 可以搜索当前层的文件夹／文件名，按名称或修改时间排序，使用上下页查看结果。
3. 点击**启动并进入会话**，就绪后自动进入聊天；已有实例点击**打开**。
4. 不再使用的网页实例点击**停止**。只关闭网页不会停止 Pi。
5. 右上角**账号与退出**可修改账号密码、退出当前或全部设备。

文件仅显示名称和类型，不能作为启动目录。搜索不递归、不读取文件内容；搜索、排序、翻页不改变已选工作区。

安装了本机 pi-stack 适配器时，终端正常运行 `pirun` 也会登记到同一个工作台，标记为“终端启动”，只提供打开，不接管停止权限。旧容器需要退出重开，不自动迁移。适配器不随通用安装自动生成，参见[接入说明](docs/local-workbench.md#pi-stack-终端接入)。

网页实例正常或异常退出后，服务核对 Docker，确认已停止或不存在才自动移出列表；Docker 断连或身份不匹配仍显示“状态未确认”。实例元数据、项目和聊天历史不会因此删除。

## 启停与更新

通用安装在原服务终端按 `Ctrl+C` 停止，再用原配置启动，**不要重新初始化**。本机已安装 pi-stack 控制器时：

```bash
pi-dockerctl local up
pi-dockerctl local status
pi-dockerctl local links
pi-dockerctl local down
pi-dockerctl local password  # 忘记密码：在本机终端隐藏输入重设
```

更新源码前先保存自己的修改，备份私有状态，并退出网页启动的 Pi：

```bash
git status --short
git pull --ff-only origin main
npm ci --ignore-scripts
npm run build
npm run verify:dist
```

然后按原部署方式安装新构建、用原配置重启。仅 `git pull` 不会替换运行中程序或宿主 `pirun` 脚本；工作台重启可能结束它持有的 Pi RPC 进程。更新 Manager 不等于更新 Pi 或 Web 扩展。

## 数据与访问边界

- `stateRoot/manager.sqlite3` 保存账号摘要、登录状态、实例元数据等，不保存模型凭据和聊天正文。
- Pi 配置、扩展、聊天历史和项目文件仍由原 Pi 环境及持久卷保存。
- 不要删卷、删数据库或反复初始化来清理在线列表。
- 手机访问需要 HTTPS 网关／隧道，并显式设置 `publicOrigin`；账号应先在本机初始化。不要公开内层 Hub 或 Docker socket。
- 网页 Pi 版本升级／回退、扩展安装更新尚未开放；版本列表是只读查询，不是更新按钮。

更多：[登录与备份](docs/local-workbench.md) · [管理员参考](docs/administrator-guide.md) · [Docker 教程](docs/docker-quickstart.md) · [来源与许可](docs/source-provenance.md)
