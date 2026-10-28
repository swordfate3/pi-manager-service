# Pi Manager 多角色完整教程

**已有可用的 Docker pirun，只想选目录直接启动？** 先看 [本地工作台](local-workbench.md)：
单页面启动、自动进入聊天，复用原启动环境，不需要下面多角色方案的申请/审批页面。
该模式默认只监听本机；需要手机公网访问时，须显式配置 HTTPS 公网入口并完成登录初始化，
见 [工作台的登录与公网边界](local-workbench.md#边界)。程序不会自动修改域名、隧道或反向代理。

Pi Manager 是单独运行的 Pi 管理程序，不是装进 Pi 的聊天扩展。它提供任务申请、独立审批和在线会话入口；聊天网页由另一个项目 **Pi Web UI `v1`** 提供。

**当前是 `0.1.0` 开发预览版，不是开箱即用的完整容器管理产品。** 本教程先让你安全地打开本机页面，再说明怎样启用第一个受管 Pi。不要求你的目录叫 `gitproject` 或 `pi_projects`，也不要求使用 WSL、阿里云或名为 `pirun` 的脚本。

## 先看当前能做什么

| 需求 | 当前状态 |
| --- | --- |
| 不启动 Pi，先打开管理页面 | 可以，按下文快速开始操作 |
| 创建、停止自己管理的 Pi | 配好原生／Docker 后端后可以；默认关闭 |
| 恢复保存的会话 | 原生实例需要配置 Web；Docker 需要对应后端，见管理员参考 |
| 用 MCP 提交、查询任务 | 可以，但申请者不能批准任务 |
| 自动接管你已经运行的 Pi／`pirun` | 不支持；网页登记不代表取得容器管理权限 |
| 网页查询官方 Pi 版本 | 可以，只读查询；网络不可用时可能显示旧缓存或不可用 |
| 网页升级／回退 Pi，安装／更新扩展 | 尚未开放，不要把版本列表当作更新按钮 |
| 自己用 Docker Compose 部署 Manager | 可以，仓库提供本机入门模板，见下方 Docker 快速开始；不自动启用 Pi 容器管理 |

只想继续用现有 Pi、在浏览器里聊天？请使用 [Pi Web UI](https://github.com/swordfate3/pi-web-ui/tree/v1)。安装 Manager 不会自动给已有 Pi 安装 Web、复制模型凭据或接管进程。

## 推荐：普通用户用 Docker 部署

**可以自己部署，不需要先成为管理员，也不需要在宿主机安装 Node/npm。** 如果你选择 Docker，直接按 [Docker 从零部署教程](docker-quickstart.md) 操作，不用先做下文的源码运行步骤。

仓库提供 [Compose 文件](../deploy/local/compose.yaml) 和 [Dockerfile](../deploy/local/Dockerfile)，流程是：下载仓库 → 构建镜像 → 初始化一次 → `docker compose up -d` → 浏览器登录。教程也包含停机、重新启动、升级、改端口和备份。

这个模板用于**可信本机试用 Manager**，不是多租户生产隔离方案。它不挂 Docker socket、不接管已有容器、不自动安装 Pi 或 Web；要由 Manager 创建独立 Pi 容器，还需要单独配置并隔离执行器。运行 Manager 的方式与它管理哪种 Pi 后端，是两件事。

## 一、准备环境

本教程使用 Linux 的 Bash 终端。WSL Linux 也可以；Windows PowerShell 不能直接执行下面的 Bash 命令。当前没有宣称 Windows 原生或 macOS 的 Pi 生命周期管理已验证。

需要已安装：Git、Node.js **22.19.0 或更高版本**、npm。先检查：

```bash
git --version
node --version
npm --version
```

只打开 Manager 页面，不需要先安装 Pi，也不需要 Docker。创建原生 Pi 时，才需要本机已有可用的 Pi。

下面命令中，`$HOME` 会自动替换成你当前 Linux 用户的主目录。`PI_MANAGER_REPO` 是源码目录，`PI_MANAGER_DATA` 是配置和任务数据目录；它们是路径变量，不是 Token。

## 二、下载并构建

在终端依次执行：

```bash
PI_MANAGER_REPO="$HOME/pi-manager-service"
git clone --branch main https://github.com/swordfate3/pi-manager-service.git "$PI_MANAGER_REPO"
cd "$PI_MANAGER_REPO"
npm ci --ignore-scripts
npm run build
npm run verify:dist
```

如果目标目录已经存在，不要删除覆盖；先确认它是不是你之前下载的仓库。`npm ci` 用于本项目自己的依赖目录，不要在 `node_modules` 指向其他项目的符号链接上运行。

构建和核验命令均正常退出后，继续下一步。这是从 Git 源码安装；当前不要使用猜测的 `npm install -g @swordfate/pi-manager` 命令。

## 三、首次初始化：先只打开管理页面

保持在源码目录，执行：

```bash
PI_MANAGER_DATA="$HOME/.pi-manager-demo"
node dist/manager/pi-manager-service.mjs init \
  --directory "$PI_MANAGER_DATA" \
  --chat-origin http://127.0.0.1:18200
```

成功时输出包含 `"initialized":true`。该命令创建新的私有目录，**不能对已有数据目录重复初始化**；不会读取或迁移你原有的 Hub、Gate 或 Pi 数据。

接着启动：

```bash
node dist/manager/pi-manager-service.mjs serve \
  --config "$PI_MANAGER_DATA/supervisor.json"
```

看到包含 `"ready":true` 的输出，表示管理服务已就绪。这个终端需要保持打开；后续查看凭据等操作，请另开一个终端。

### 打开哪个页面？

在运行 Manager 的电脑上使用浏览器打开：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:18201/` | 申请者页面：提交、查询自己的任务 |
| `http://127.0.0.1:18202/` | 管理员页面：审阅并批准任务 |
| `http://127.0.0.1:18200/sessions/` | 已登记的在线 Pi 列表 |
| `http://127.0.0.1:18201/mcp` | 给 MCP 客户端使用，不是普通网页 |

**此时会话列表为空、创建按钮不能用，是正常现象：还没有配置启动后端。** 先完成登录，再根据需要阅读第五节。

这些是教程的默认端口，不是强制端口。如果已被占用，请在首次 `init` 时同时指定三处不同且空闲的入口，例如：

```bash
node dist/manager/pi-manager-service.mjs init \
  --directory "$HOME/.pi-manager-demo-alt" \
  --chat-origin http://127.0.0.1:18400 \
  --public-origin http://127.0.0.1:18401 \
  --admin-origin http://127.0.0.1:18402
```

然后使用新目录的 `supervisor.json` 启动，并访问新端口。若已有服务正常运行，不要为了尝试端口再启动一套相同配置。

## 四、登录：申请者和管理员用不同凭据

初始化会生成两个文件，没有固定默认密码：

| 文件 | 填在哪里 |
| --- | --- |
| `requester-credential.json` | `18201` 申请者页面的 `Credential` 输入框 |
| `administrator-credential.json` | `18202` 管理员页面的 `Credential` 输入框 |

在另一个**可信本机终端**，按你实际的数据目录查看相应值：

```bash
PI_MANAGER_DATA="$HOME/.pi-manager-demo"
node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).credential)' \
  "$PI_MANAGER_DATA/requester-credential.json"
```

管理员登录时，将最后的文件名换为 `administrator-credential.json`。只复制输出的值，不复制整个 JSON。

**上面命令会把凭据显示在你自己的终端。** 不要在共享屏幕、公开日志或模型工具调用中执行，也不要把结果发给 Agent。管理员凭据只由你保管；它与反向代理／公网入口的登录密码不是同一套东西。不要通过删除配置重新初始化来重置密码。

页面点 `Unlock` 登录、点 `Lock` 锁定。管理员页面刷新后需要重新登录，短期登录令牌不保存在浏览器存储里。

## 五、创建第一个 Pi：可信本机原生模式

这节适合自己在本机试用，**不是用于运行不可信 Agent 的安全沙箱**。运行用户能访问的其他文件，原生 Pi 也可能有权访问。需要容器隔离时先阅读第七节，不要把此模式公开给陌生人。

### 1. 确认 Pi 已经安装

```bash
command -v pi
pi --version
```

`command -v pi` 应返回一个可执行文件的绝对路径。不要将 Bash 函数 `pirun` 或一段 shell 命令作为 `--native-executable`。

### 2. 初始化一个启用了原生后端的新实例

如果第三节的试用 Manager 仍在运行，先在它的终端按 `Ctrl+C` 停止。这里使用**另一个全新数据目录**，不覆盖第三节的试用数据。

```bash
PI_MANAGER_REPO="$HOME/pi-manager-service"
PI_MANAGER_DATA="$HOME/.pi-manager-native"
PI_MANAGER_PROJECTS="$HOME/projects"
PI_MANAGER_EXECUTABLE="$(command -v pi)"
mkdir -p "$PI_MANAGER_PROJECTS/demo"
cd "$PI_MANAGER_REPO"
node dist/manager/pi-manager-service.mjs init \
  --directory "$PI_MANAGER_DATA" \
  --chat-origin http://127.0.0.1:18200 \
  --trusted-local-native yes \
  --native-executable "$PI_MANAGER_EXECUTABLE" \
  --workspace "$PI_MANAGER_PROJECTS"
```

你可以把 `PI_MANAGER_PROJECTS` 改成自己的项目根目录。当前源码按配置的允许根目录校验，**尚未实现统一的“宿主 Home 外禁止创建”规则**；这里选 Home 内目录是教程建议，不代表其他路径会自动被全局拒绝。

### 3. 配置可以选择的项目

用文本编辑器打开新数据目录里的 `executor.json`。保留凭据摘要、socket、`native` 等其他内容，只将 `workspaces` 对象改为：

```json
"workspaces": {
  "demo": {
    "label": "我的示例项目",
    "root": "allowed",
    "path": "demo"
  }
}
```

这是完整 JSON 中的一个字段，不是整个文件；也不是可以直接执行的 Bash 命令。

- `demo`：项目选项的 ID；`label`：页面显示名称，可以修改。
- `root: "allowed"`：引用初始化生成的项目根，不是一个宿主目录名。
- `path: "demo"`：该根下面的相对目录，也就是上面创建的 `$HOME/projects/demo`。
- 当前是预先配置的目录下拉列表，**还没有任意目录浏览器或网页新建文件夹功能**。目录需提前存在；新增项目时添加一个同样结构的选项。

配置后启动：

```bash
node dist/manager/pi-manager-service.mjs serve \
  --config "$PI_MANAGER_DATA/supervisor.json"
```

### 4. 提交并批准

使用**这个新数据目录**生成的两份凭据登录，不要继续用第三节旧实例的凭据。

1. 在 `18201` 页面选择 `Create managed Pi`。
2. `Target ID` 填 `demo-1`。这是实例名，只使用英文字母、数字、下划线和短横线，首位为字母或数字，最长64字符。
3. `Allowed directory` 选择“我的示例项目”，点击 `Submit for independent approval`。
4. 记下页面显示的任务编号；状态 `pending_approval` 表示已收件、未执行。
5. 到 `18202` 管理员页面点 `Refresh tasks`，找到同一编号，点 `Review`。
6. 核对动作、实例、目录选项与修订号，再点 `Approve and execute this revision` 并确认。
7. 点 `Refresh tasks` 查询结果。`succeeded` 才表示该管理任务成功；`failed` 不是成功，`unknown` 不能盲目重试。

### 5. 为什么 Pi 创建了，网页仍没有聊天？

上面的最小配置只验证创建／审批／停止流程，**没有自动接入 Web 和可用模型**。创建成功不证明模型调用或网页聊天成功。

原生后端使用独立 HOME 和 Pi 配置，默认关闭工具、技能、MCP及个人扩展自动发现；不会继承你普通终端的模型登录、API Key、代理或全部 Pi 设置。因此它也不是原有 `pirun` 环境的复制品。

要让新实例出现在会话门户，管理员还需完整安装干净 Web 包，并为 `native.web` 配置扩展入口、Manager 的 `chat.json` 和起始端口。要正常回答，还需显式配置可用的 provider。详见 [管理员参考：原生 Pi](administrator-guide.md#启用原生-pi仅可信本机)。**当前没有自动导入个人模型认证或一键设置普通模型的向导；如果不会配置 provider，先停在这里，不要把测试 provider 当成真实模型服务。**

### 6. 停止和恢复

申请者页面选择 `Stop owned Pi`，`Target ID` 填原实例名 `demo-1`，提交后由独立管理员核对并批准。不要把任务编号填进实例名。

原生实例只有配置了 Web 才开放 `Restore owned Pi`；恢复会用保存的会话启动新进程，不接管旧 PID。这里只管理自己创建的实例，不接管终端里另外启动的 Pi。

## 六、日常启动、停止与数据保存

第二天再用时，**不用重新 init**。重新打开终端，设好路径并执行：

```bash
PI_MANAGER_REPO="$HOME/pi-manager-service"
PI_MANAGER_DATA="$HOME/.pi-manager-demo"
cd "$PI_MANAGER_REPO"
node dist/manager/pi-manager-service.mjs serve \
  --config "$PI_MANAGER_DATA/supervisor.json"
```

使用原生示例时，把数据目录改成 `$HOME/.pi-manager-native`。`serve` 是前台运行，停止用原终端的 `Ctrl+C`。

**可信本机主管停止时，也会清理其拥有的原生 Pi 子进程，不是“只关网页、Pi继续运行”。** Manager 自己启动的受管 Pi与外部手动 Pi不同。重启不会自动把所有历史实例恢复成在线状态。

数据目录包含凭据、配置、任务和审计；原生配置中的 `native-state`、`native-agents` 等位置还保存受管实例数据。源码目录不是数据目录。备份时先停止服务，保留完整私有数据目录，不只复制 `chat-runtime`；socket 是运行态，不是聊天记录。

不要删除数据目录来清空在线列表、不要重跑 init 来修复配置、不要把备份提交到 Git。保留状态意味着重启后仍能查询历史任务，但不意味着已经批准的队列会自动执行；结果不明的任务需人工核实。

### 以后怎样更新 Manager 自己？

先停止这个试用 Manager，并备份完整私有数据目录。然后在源码目录更新：

```bash
PI_MANAGER_REPO="$HOME/pi-manager-service"
cd "$PI_MANAGER_REPO"
git status --short
git pull --ff-only
npm ci --ignore-scripts
npm run build
npm run verify:dist
```

如果 `git status --short` 显示自己修改过的文件，先保存并处理这些改动，再执行后续命令，不要强制覆盖。更新后用原数据目录的 `supervisor.json` 重新 serve，**不要 init**。先阅读更新说明；涉及配置格式变化时按迁移说明操作，不假设任意旧配置都能直接升级。

这只更新 Manager，不会升级它管理的 Pi 或 Web 扩展，也不会自动恢复所有 Pi。

## 七、Docker、MCP 与手机访问怎么选？

### Docker：普通用户也可以直接部署

直接使用仓库内的 [Compose 入门模板](../deploy/local/compose.yaml)，按 [Docker 从零部署教程](docker-quickstart.md) 构建、初始化并启动。宿主机只需 Git、Docker Engine 和 Compose 插件，不需要安装 Node/npm。模板采用 Linux host 网络以兼容当前仅监听回环地址的服务；不是 Windows 原生／macOS 通用模板。

**在 Docker 里运行 Manager，不等于已经允许 Manager 创建 Pi 容器。** 入门模板只启动 Manager，不挂 Docker socket，也不复制你现有的 Pi 环境。创建独立 Pi 容器需要另外准备 Pi 镜像、固定 daemon 身份、允许目录、持久化和 Web 配置，并实际隔离四个角色；模板不声称已经自动完成这些工作。

Docker 管理接口只能交给受限执行器，不能交给申请者网页、MCP 或普通 Pi。原生与 Docker 后端不能同时启用。进一步步骤见 [Docker 后端参考](administrator-guide.md#docker-后端)。

### MCP：让 Agent 申请，不给它审批权

这是可选功能；不用 MCP 也能在网页提交申请。客户端配置形状为：

```json
{
  "mcpServers": {
    "manager": {
      "url": "http://127.0.0.1:18201/mcp",
      "headers": {
        "Authorization": "Bearer ${PI_MANAGER_REQUESTER_TOKEN}"
      }
    }
  }
}
```

`PI_MANAGER_REQUESTER_TOKEN` 是**客户端进程**需要读取的申请者凭据变量，不是内置默认 Key。客户端必须支持此变量替换；按客户端自己的文档配置。不要把管理员值填进去。Manager 启动的原生 Pi 默认没有启用 MCP，此示例不会自动改变它。

同一宿主上使用 host network 的容器可按实际网络访问回环入口；普通 bridge 容器的 `127.0.0.1` 是容器自己，不能假设能访问宿主 Manager。改变监听或代理设置前需要管理员审查，不要直接裸露管理端口。

工具包括 `manager_submit_task`、`manager_get_task`、`manager_list_tasks`，以及只读的 `manager_list_pi_versions`。不提供批准工具，也不支持任意 shell 或自选 Docker 参数。

### 手机：本教程没有把服务暴露到公网

手机上的 `127.0.0.1` 是手机自己，不能拿上述本机地址直接访问电脑。需要另配可信 HTTPS 网关和安全网络通路；本项目不要求特定云厂商或隧道产品。

聊天、申请者和管理员是不同权限入口，管理入口应使用独立来源和精确 Host／Origin 配置，不能简单在同一聊天域名下面拼 `/admin` 代替隔离。公网网关的登录和 Manager 的管理员凭据也不是同一回事。**普通用户先只在本机使用；当前没有一键手机部署向导。**

## 八、常见问题

| 现象 | 应该怎么办 |
| --- | --- |
| `command not found` | 检查 Git／Node／npm／Pi 是否已安装，别在 Pi 聊天输入框执行 Bash 命令 |
| clone 提示目录存在 | 确认是不是已有仓库，不要直接删除或覆盖 |
| init 失败，目录已存在 | 使用原配置 serve；新试用使用不同的新目录，不反复初始化 |
| serve 提示启动失败 | 核对端口、配置 JSON 和目录权限。异常退出可能保留锁，别批量删锁；先确认旧进程退出，再由管理员排查 |
| init 路径合法仍被拒绝 | Unix socket 路径有长度限制；使用较短的私有数据目录，且不要与项目目录重叠 |
| 页面无法打开 | 先确认终端有 `ready:true`，地址／端口与初始化一致；远程浏览器不能用自己的 localhost 代替服务器 |
| `Lifecycle execution is not configured`，创建按钮禁用 | 入门模板默认未启用 Pi 后端；原生步骤见第五节，Docker 容器管理的额外配置见 Docker 教程的能力边界 |
| 目录选项不对 | 停止服务，核对 `executor.json` 的根目录、`workspaces` 和实际存在的子目录，再启动 |
| 管理员登录失败 | 使用当前实例的 `administrator-credential.json`，不是申请者凭据或公网密码；刷新后需重登 |
| 任务一直 `pending_approval` | 还没有管理员审阅并批准，提交不等于执行 |
| 审批后结果没有变化 | 刷新同一任务编号；检查 `queued`／`running`／`failed`／`unknown`，不要重复创建另一个同名实例 |
| 创建成功但门户为空 | 尚未配置 Web 登记，或登记失败；不能据此断言模型可用 |
| 网页不能回答／没有原来扩展 | 受管实例不继承普通 Pi 的配置与凭据，且默认关闭工具和自动发现；需要管理员明确配置 |
| 看见版本却不能升级 | 当前版本查询只读，Pi升级／回退和扩展更新尚未开放 |
| 页面显示英文 | 当前按钮是英文；本教程给出对应名称，未宣称界面已完整汉化 |

## 管理员与开发者文档

- [管理员参考：权限、后端、接口和故障边界](administrator-guide.md)
- [Docker 从零部署：构建、初始化、登录、启停、升级与备份](docker-quickstart.md)
- [Hub 网页创建与批准 Pi 容器：目录选择、固定环境与独立持久化](hub-create-pi.md)
- [实施与验收状态](validation/2026-10-26-manager-service-progress.md)
- [来源及许可记录](source-provenance.md)
- [源码迁移清单](migration-inventory.json)

`pi-manager-service` 是本教程使用的新主管命令；`pi-manager` 保留的是旧 Hub 兼容 CLI，不要混用它们的 `init` 参数和配置文件。

本次教程描述当前能力，不会自动启用未配置的后端，也不代表已经完成生产部署、安全隔离或个人状态迁移。
