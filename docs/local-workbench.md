# 本地工作台：选目录，启动，进入会话

这是简化的单账号登录工作台，与原多角色管理服务独立。只监听 `127.0.0.1`，
默认不配置域名、隧道或阿里云。登录一次后即可操作，没有令牌输入、管理码、
管理员页面跳转或手动审批。本次本地安装不改变公网入口。

## 使用

第一次打开本地工作台会进入登录页，请自己设置用户名和至少12字符的密码。
不提供固定默认账号密码。之后登录会保持7天，服务正常重启仍有效。手机和电脑
登录后具有完全相同的功能，不会因手机访问增加审批。

登录后默认选好部署者配置的工作目录。点击文件夹可以更换目录，
进入即选中。点击 **启动并进入会话**，实例自动命名，就绪后自动进入聊天。
工作台同时列出已有的本地实例，可以手动进入或确认停止。

关闭浏览器不停止 Pi。停止只操作该实例，不删除项目、会话或共享卷。
确认停止后，该实例会自动移出首页列表；正在停止、启动失败或状态未确认的实例
仍保留提示，避免把尚未确认停止的进程误当作已退出。只完成一轮回答不会停止实例。
后台保留启动元数据用于状态核对和请求去重，不把它作为运行实例展示；聊天历史
仍由 Pi 持久化保存，新实例可继续恢复历史会话。
本地服务调用原来的 pirun 脚本，沿用 Compose Pi 服务、持久卷、模型、扩展、
技能、SSH/HF 配置与截图生命周期，没有另起一套精简环境。使用 Pi RPC 模式，
不占用人工终端；需要原生 TUI 时仍在终端运行 pirun。Pi Web 扩展须已安装启用。
多个实例共享原 pirun 的 home 和扩展状态，不承诺独立账号、历史或缓存。

## 配置

需要 Linux、Docker Compose、可正常使用的 pirun、已启用的 Pi Web 扩展、
Node >=22.19.0。构建后运行：

```bash
node dist/manager/pi-manager-local.mjs --config /absolute/private/local-config.json
```

配置示例，所有路径均由部署者自行设置：

```json
{
  "port": 18403,
  "chatPort": 18404,
  "home": "/home/alice",
  "workspaceRoots": { "projects": "/home/alice/projects" },
  "defaultWorkspace": { "root": "projects", "path": "my-project" },
  "stateRoot": "/home/alice/docker_files/pi-stack/local-workbench/state",
  "launcher": "/home/alice/docker_files/pi-stack/scripts/pirun",
  "hubCli": "/opt/pi-manager/dist/hub/pi-web-hub.mjs",
  "protectedRoots": ["/home/alice/docker_files/pi-stack"],
  "dockerExecutable": "/usr/bin/docker",
  "startupTimeoutMs": 120000
}
```

配置文件0600、状态目录0700，属于运行服务的宿主用户。两个端口都只监听回环。
根目录必须严格位于配置的 Home 内；项目目录必须已存在，不允许 `..`、绝对路径、
符号链接逃逸，或选中包含管理程序/私有状态的目录。

`deploy/local/install-local-workbench.mjs` 是本机 pi-stack 适配安装器，不是
任意部署的通用初始化器。该安装器还依赖源码仓库旁的 `../pi-stack-deployment/`
启动脚本；这个部署目录不包含在本源码仓库中。单独克隆本仓库时，请使用上面的
显式配置启动方式，并自行提供兼容的启动器，不要直接运行该适配安装器。
产物放在该栈 `local-workbench/`，宿主脚本先备份后
更新，生成独立用户服务，不修改四角色配置或公网连接。安装后统一入口为：

```bash
pi-dockerctl local up
pi-dockerctl local status
pi-dockerctl local links
pi-dockerctl local down
pi-dockerctl local password   # 本机交互终端重设账号/密码，隐藏密码输入
```

## 登录和密码

工作台右上角 **账号与退出** 可修改用户名、密码或退出当前/全部设备。
修改密码必须提供当前密码，成功后全部设备需要重新登录；忘记密码时在宿主机
执行 `pi-dockerctl local password`，不需要知道旧密码，不需要在聊天中发送新密码。
通用安装也可以执行：

```bash
node /opt/pi-manager/dist/manager/pi-manager-local.mjs account-reset --config /absolute/private/local-config.json
```

账号初始化和重置均不改变 Pi 配置、扩展或持久卷。退出登录会断开该登录的
WebSocket，但不会停止 Pi 容器。没有无账号模式或备用后门。

## SQLite和缓存

在 `stateRoot/manager.sqlite3` 保存账号摘要、随机会话的哈希、启动元数据、最近
启动的目录偏好和最多1000条不含正文的安全事件。不保存明文密码、对话、模型或
项目文件。无需 PostgreSQL/Redis，Node22的内置SQLite仍会给出实验性提示。
每账号最多64个有效设备会话，淘汰最旧登录，不限制Pi实例业务操作。

旧 `runs.json` 首次启动时原样备份到 `runs.json.pre-sqlite.bak`，验证后事务导入，
之后只写SQLite，不再双写JSON。原文件保留，后续重启不会再次导入。
损坏记录会使启动失败，不会当作空记录覆盖。不要手工删除数据库来“修复”。

目录列表缓存最多64项、2秒；启动会绕过缓存重新验证。工作台脚本使用私有ETag
条件缓存；HTML、账号、API、聊天及下载不共享缓存。响应 `Server-Timing` 可查看
服务端耗时和目录缓存hit/miss。缓存不可能让Docker启动/模型响应变成零耗时。

升级安装器会先保存旧产物、配置和SQLite一致性备份到栈的 `backup/`。
人工备份应在服务停止后复制整个 `stateRoot`，或者使用SQLite在线备份API；不要在
写入中仅复制数据库文件。恢复认证数据会恢复其中尚有效的登录，恢复后建议立即
使用本机密码重置来撤销旧设备。

## 状态与恢复

重复提交同一请求返回原实例，不创建第二个容器。启动超时显示“状态未确认”，
保留原申请，先刷新核对。只有本次启动的精确会话就绪才自动跳转；历史实例
必须手动打开。服务重启不重放请求，按保留的实例记录核对原容器。

启动器原始输出可能含凭据或对话，因此不写入网页或服务日志，只显示安全的
失败分类。正常关闭本地服务会关闭自己持有的 RPC 输入；停止是否完成需要
核对，不能把关闭网页或关服务当作容器已清理。命名卷和会话数据不会被删除。

## 边界

首页、管理API、聊天、下载和WebSocket都需要有效登录。账号接口、HTML不缓存，
密码用有界scrypt摘要；会话用HttpOnly Cookie，带CSRF及精确Host/Origin检查。
代理不会把管理Cookie、Authorization和用户断言头传入Pi扩展，Pi也不能下发
管理Cookie。没有登录不等于可访问会话URL；知道URL不能绕过门禁。

接入手机公网时必须显式配置 `"publicOrigin": "https://pi.example.com"`，
反向代理保持Host并正确转发WebSocket；这种模式使用Secure Cookie并禁止网页
首次初始化，先从本机终端设置账号。服务不会相信X-Forwarded-*自动启用公网，
也不会替用户改DNS/Caddy/隧道。不要将HTTP本机初始化模式原样转发到公网。

仍然信任宿主机及同UID进程：内层Hub和注册socket仅回环/私有目录可用，不是
防御已经控制宿主的攻击者。宿主控制器能调用Docker，普通Pi不挂Docker socket。
这不是多租户隔离或对同机恶意Agent的沙箱。公网接入仍需单独端到端验收。
