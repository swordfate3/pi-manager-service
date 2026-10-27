# Pi Manager

Pi Manager 是独立于 Pi 启动的管理程序；Pi Web `v1` 是负责聊天的薄扩展。先启动 Manager，即使一个 Pi 都没有，也能打开管理网页，再申请创建第一个 Pi。

开发预览版本，尚未正式发布；实际启用的后端由部署策略决定。**创建、独立审批、停止、保存数据后恢复，以及只提交／查询任务的 MCP 已接通；版本和扩展更新仍在开发，不能把候选包下载成功当成更新成功。** 仓库不包含个人部署的凭据、状态和数据卷；仅启用会话门户的部署也不等于已经开放生命周期管理。

```text
管理网页 / MCP → 公共入口 → 受限执行器 → 自己创建的 Pi
                              ↑                 └─ Pi Web：聊天
                      独立管理员审批                  ↓
                                         Manager 会话门户
```

公共入口、私有管理员入口、执行器、会话门户是四个独立服务。可信本机开发时可用一个主管命令统一启动；面向不可信 Agent 时必须实际分离用户／容器和挂载权限，不能仅靠不同端口或不同 HOME。

## 从源码运行

需要 Node `>=22.19.0`。本轮实际验收平台是 Linux；原生后端依赖 Linux `/proc`。没有宣称 Windows 原生或 macOS 生命周期已通过。

```bash
npm ci --ignore-scripts
npm run build
node dist/manager/pi-manager-service.mjs --help
```

`npm ci` 只能用于自己的独立依赖目录，不能在指向其他项目的共享 `node_modules` 链接上执行。构建产物的完整性校验不需要开发依赖；打包安装测试会在全新临时目录安装真正声明的运行依赖。

## 零 Pi 启动：可信本机开发

下面的 `init` 只能创建新目录，不会读取或覆盖现有 Hub/Gate/Pi 状态。将示例路径换成你自己的**新私有目录**。

```bash
node dist/manager/pi-manager-service.mjs init \
  --directory /absolute/new-manager-data \
  --chat-origin http://127.0.0.1:18200

node dist/manager/pi-manager-service.mjs serve \
  --config /absolute/new-manager-data/supervisor.json
```

默认入口：

| 入口 | 用途 |
| --- | --- |
| `http://127.0.0.1:18200/sessions/` | Pi 会话门户，零 Pi 时列表为空 |
| `http://127.0.0.1:18201/` | 申请、查询自己的任务；页面有会话门户链接 |
| `http://127.0.0.1:18202/` | 私有管理员登录、核对精确任务、批准执行 |
| `http://127.0.0.1:18201/mcp` | 使用申请者凭据的 MCP HTTP 接口 |

默认没有启用生命周期后端，因此不能创建 Pi。初始化文件包括：

| 文件／目录 | 内容 |
| --- | --- |
| `supervisor.json` | 四个服务的固定配置文件位置 |
| `public.json`、`admin.json` | 各自的监听来源和 IPC 路径 |
| `executor.json` | 允许的后端、目录、凭据摘要和执行策略 |
| `chat.json` | 会话门户监听、登记状态和运行目录 |
| `requester-credential.json` | 申请者登录凭据，不具有批准能力 |
| `administrator-credential.json` | 独立管理员登录凭据，不能交给 Agent |
| `tasks/` | 唯一执行器维护的持久任务和审计 |
| `submit/`、`admin/` | 分开的申请／批准 IPC 目录 |
| `chat-state/`、`chat-runtime/` | 登记状态和会话路由 socket；不是 Pi 会话数据 |

凭据只写入私有文件，不会打印在初始化输出中。不要把管理员凭据粘贴到模型对话。管理员页只在内存保存短期登录令牌，不使用 Cookie 或浏览器存储；刷新后需要重新登录。端口不同不能隔离 Cookie，因此不能改回跨端口共享的登录 Cookie。

## 启用原生 Pi（仅可信本机）

初始化时显式指定已安装的 Pi 和允许的目录：

```bash
node dist/manager/pi-manager-service.mjs init \
  --directory /absolute/new-manager-data \
  --chat-origin http://127.0.0.1:18200 \
  --trusted-local-native yes \
  --native-executable /absolute/path/to/pi \
  --workspace /absolute/allowed-projects
```

之后在私有 `executor.json` 中补充管理员批准的工作区选项及**已安装的干净 Web 包**：

```json
{
  "native": {
    "web": {
      "extensionPath": "/absolute/installed-pi-web/extensions/mirror-server.ts",
      "hubConfigFile": "/absolute/new-manager-data/chat.json",
      "port": 18310
    }
  }
}
```

这是补充片段，不要用它覆盖完整 `executor.json`。Web 包及其运行依赖必须完整安装，不能只复制单个 TypeScript 文件。多个 Web 实例依赖扩展自己的端口选择／登记，不能用上面的单个端口断言任意部署均无冲突。

后端默认关闭项目／HOME 扩展、上下文、工具和 MCP 的自动发现，重新构造子进程环境，也不会继承个人模型凭据。测试使用明确配置的确定性 provider。正常模型服务需要另外显式配置管理员批准的 provider；**这个版本还不是自动复制现有个人 Pi 环境的安装器**。

管理网页选择 `Create managed Pi`、目标 ID、已允许目录，提交后任务进入 `pending_approval`，不会立即启动。管理员在另一入口核对目标和修订号后批准。停止也走同一审批路径。配置了 Web 的原生实例可以选择 `Restore owned Pi`：启动新进程，加载原保存数据，重新登记；不接管磁盘记录里的旧 PID。

原生同 UID 下，Pi 仍可能访问该用户有权访问的其他文件。目录白名单只限制启动目录，不是文件系统隔离；不可信 Agent 应使用经过验证的容器／账户权限部署。

## Docker 后端

管理员在 `executor.json` 中选择 `docker`，同时将 `native` 设为 `null`。公共请求只能选择已批准目录、动作和目标 ID，不能指定镜像、命令、挂载或 Docker 参数。

固定策略包括本地 daemon 身份、完整 `sha256` 镜像 ID、宿主路径坐标、独立私有日志目录和允许的工作区根。默认 UID/GID `1000:1000`、只读系统层、丢弃全部 capabilities、`no-new-privileges`、资源和日志限制；默认不联网。Web 登记是显式的 host-network 选项，不能宣称该选项提供网络隔离。

每个新实例拥有自己的持久 home 卷；停止和恢复保留同一个精确容器及数据卷。Web 配置会继续原来保存的对话，不是只保留一个空 home。后端没有自动拉取／构建／清理镜像、删除 home、接管其他容器的接口。

如果执行器本身运行在容器内，Docker bind mount 的 Source 仍由**宿主 daemon**解释。必须显式保证路径坐标一致，不能把执行器里的 `/data` 误当成宿主的同一目录。Docker socket 只能给受限执行器，不能挂到公共入口、MCP 或 Pi Agent。

## MCP

当前使用官方 Streamable HTTP SDK。公共来源的 `/mcp` 要求申请者 Bearer 凭据。已有三个任务工具，另在本地开发中接入只读版本查询：

- `manager_submit_task`：提交受限的创建／停止／恢复申请。
- `manager_get_task`：查询自己的持久任务。
- `manager_list_tasks`：列出自己的任务。
- `manager_list_pi_versions`：只读查询官方稳定 Pi 版本，可按数字前缀搜索和分页；不提交更新、不批准任务，也不安装候选。

没有批准工具，没有任意 shell／Docker 参数，也没有通过请求覆盖 requester 的能力。客户端退出不取消已经由执行器接手的任务。

实际 Pi 1.1.0 客户端配置形状已用隔离配置验证：

```json
{
  "mcpServers": {
    "manager": {
      "url": "http://127.0.0.1:18201/mcp",
      "headers": { "Authorization": "Bearer ${PI_MANAGER_REQUESTER_TOKEN}" }
    }
  }
}
```

只给这个客户端提供申请者变量；不要给它管理员凭据或批准 socket。远程连接使用可信 HTTPS 网关并保留精确 Host／Origin 校验。项目不依赖阿里云、WSL 或某个固定用户名；本轮没有修改任何公网、TLS、登录或隧道配置。

## 更新、恢复与故障边界

- 任务持久保存 ID、请求者、幂等键和修订号；响应丢失先查询原 ID，不换一个键盲目重做。
- 队列中未执行的批准不会跨执行器重启自动恢复，需要重新核对。
- 重启时正在执行但结果未确定的任务变为 `unknown`，禁止自动重放；需管理员核实实际资源。
- 原生实例逻辑名称保留，不允许另一个用户复用；恢复只使用私有成功记录和保存数据。
- [官方候选包模块](manager/updates/README.md)包含精确来源／完整性校验、严格解包、全局写入锁和总量限制。单纯下载的结果仍是 `prepared-unverified`；后续已另行实现隔离递归安装、私有兼容性验证和原生切换协调器，但**完整的审批／更新接线及当前源码的真实升级、回退与故障验收尚未完成，因此界面仍不开放版本更新**。某次安装或探测成功不能代替完整更新验收；最新范围见实施记录顶部。
- 扩展安装／更新／移除及完整更新互斥流程仍未完成。保留旧 Gate/runtime 源码不等于新的 Manager 已接好它们。

## 验证

```bash
npm run build
npm run verify:dist
npm run test:package
npm run test:unit
npm run test:gate:offline
npm run test:runtime:offline
```

真实 Pi/Web、Docker、新权限域和浏览器测试都使用临时状态及假模型，不进入默认测试。需要按各自测试的显式 opt-in 运行，不使用生产卷、真实会话或个人凭据。未运行的项目必须保留为未运行，不能拿遗留测试结果代替新服务验收。

`pi-manager-service` 是新增服务主管入口；`pi-manager` 暂时保留旧 Hub CLI 的 `init/serve/issue/revoke` 等命令用于兼容，不是同一个配置格式。独立权限部署使用 `pi-manager-public`、`pi-manager-admin`、`pi-manager-executor`、`pi-manager-chat` 各自的 `--config`，不能把可信本机主管当成权限隔离方案。

## 文档与交付边界

- [拆分设计与验收标准](docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md)
- [实施与验收历史](docs/validation/2026-10-26-manager-service-progress.md)
- [来源及许可记录](docs/source-provenance.md)
- [逐文件迁移清单](docs/migration-inventory.json)
- [原实验性权限探针](integration-tests/manager-isolation/README.md)（不是新服务的隔离验收）

本地开发不自动迁入真实 Pi／Hub／Gate，不停止旧部署、不修改域名和密码、不推送／合并／发布。上线需要完整兼容性、权限域和更新验收，以及单独批准的迁移、试运行、切换和恢复点流程。
