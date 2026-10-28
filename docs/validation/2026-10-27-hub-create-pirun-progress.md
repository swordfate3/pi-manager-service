# Hub 网页创建 Pi：实施与验收记录

日期：2026-10-27。开发分支：`codex/hub-create-pirun`。基线：`e25192676822b4915653484bb91d20e69d2fe267`。

用户已确认在 Hub 管理员网页直接批准创建容器，不要求终端 approve。本次是源码开发与隔离验收，**尚未部署**，不重启现有 Manager/Chat/Pi，不迁移生产会话，不推送或合并。

## 已实现并检查：目录、申请、网页批准

- 可选显式宿主 Home/项目根目录策略；不以执行器的临时 HOME 推断宿主目录，不写死个人路径或域名。
- 认证后的已存在目录浏览、最多200个允许目录、根/上级/子目录导航与显式选中。动态请求只包含根 ID 和相对路径。
- 过滤私有状态、socket、管理代码等受保护分支；禁止越界、符号链接和包含私有分支的目录选择。浏览根可包含私有分支，但不自动获得选择该根的权限。
- 创建申请持久保存精确目录，提交、独立管理员批准、执行前重新验证。重复提交返回原任务，包括原目录已消失的情况。
- 管理员网页原有精确任务审查/批准复用；申请者、公共 MCP 和 Pi 不具有批准权限，仍不允许身份自批。
- 退出登录与重新登录使旧目录、任务、审批异步响应失效。目录加载中/失败时不允许误选之前的目录。
- 不启用浏览策略时兼容静态选项及禁用后端；静态配置保留 `alpha/.`、`alpha//child` 等原先可接受形式的规范化。

### 当前测试证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `node --import ./tests/register-ts.mjs tests/manager-workspaces.test.ts` | 10/10通过 | 真实临时目录、本机HTTP/Unix服务；非真实Docker |
| `node --import ./tests/register-ts.mjs tests/manager-version-query.test.ts` | 11/11通过 | UI VM、异步导航/退出、旧界面行为 |
| Docker/MCP/service三文件回归 | 34通过、0失败、1个浏览器项默认跳过 | Docker为假daemon，非生产daemon |
| 显式Chromium `real browser:` 项 | 1/1通过 | 网页提交/管理员批准、桌面与手机宽度；假Pi |
| `npm run typecheck` | 通过 | 当前Task1源码 |
| `git diff --check` | 通过 | 当前工作区 |
| 既有 `integration-tests/docker-web.test.ts` 显式真实Docker预检 | 1/1通过，44.5秒 | 临时Pi登记/WS假模型对话/stop410/原容器home与历史恢复；非新broker闭环 |

沙箱禁止本地监听的 EPERM 不记作断言失败；上表 socket/browser 项已在批准的临时测试权限下执行。先有 RED，再有修复后 GREEN；详细命令、回归和审查在本计划的开发记录中。

真实Docker预检使用精确本地镜像和独立干净Web v1包，未挂现有Pi卷/凭据。测试仅清理自身容器与新卷，核对已有容器StartedAt/Running/RestartCount不变。该成功不能代替下文尚未完成的新broker/网页批准闭环。

## 固定运行模板与窄范围登记：源码和真实闭环均已验证

Task2新增专用Unix登记签发/就绪接口，执行器仅收到成功/就绪状态；每实例独立凭据由Chat写入私有文件，Docker直接只读挂载该单文件。任务UUID持久绑定原授权，崩溃后重试不会另发一份。固定runtimeProfile支持只读/NoCopy程序卷、模型文件、显式环境及扩展包，保留独立home，开启工具但不自动加载项目插件。新建/启动必须完成实际登记证明，而不是仅凭Docker Running。

Task2专项及兼容回归52/52通过，包含真实Unix/HTTP、文件权限/FIFO检查与假Docker；类型检查及diff检查通过。独立审查已通过（spec与quality均通过，0个未解决问题）。下文独立记录真实分UID Docker验收，不以专项测试替代。

为嵌套模型文件挂载准备了独立无生产标签测试镜像：`sha256:a765c3e1975b899621f676038104e7a035c419db563756ddf761dab28c754050`。其基础精确ID为`sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6`，仅以UID1000预建`.pi/manager-agent`并写入准备标记，没有运行时root初始化或生产镜像替换。BuildKit不接受裸sha256作为FROM名称，首次构建因此失败；改用已核验同ID的本地基础标签后成功。Dockerfile无默认BASE_IMAGE导致的静态lint警告已记录，不影响显式传参的构建。

## 真实网页批准到Pi对话验收

`integration-tests/hub-create-pi/acceptance.test.mjs`第三轮完整通过：1/1，42.39秒，证据`/tmp/hcpi-WDfbNo/evidence.json`。

- 实际申请者HTTP浏览目录并提交；重复请求同任务，未批准前无Pi/授权，越界/私有目录和未授权批准被拒绝。
- 实际管理员HTTP登录、审查精确目录并批准；等待实际登记证明完成才返回succeeded。
- Chat/Pi UID1000，执行器真实Docker UID21001，签发socket专用GID21002/0660。独立无socket权限探针确认Chat私有配置EACCES；实际执行器未挂Chat私有目录，直接路径ENOENT。
- 真实Pi挂载、node UID、只读根、cap-drop/NNP检查通过；模型文件EROFS，auth/settings/model-store可写。显式扩展和确定性provider通过Hub WebSocket返回测试回答。
- 批准stop，原会话410，home保留；关闭并重新启动执行器后批准start，同一容器/home/grant恢复，原用户和助手历史可读。共享只读NoCopy程序卷前后摘要不变。
- 23个测试前已有容器的ID/StartedAt/Running/RestartCount逐一保持不变。本轮全部测试helper、Pi容器及新home/runtime卷已精确清理；cleanupErrors为空。保留owner-only临时证据与日志，不进行广泛清理。

前两轮失败均有证据，没有记为通过：首轮临时helper缺少FSETID导致setgid被清除（`/tmp/hcpi-2112xx/evidence.json`）；第二轮已经完成创建/对话，但测试嵌套eval转义错误（`/tmp/hcpi-kc0oxQ/evidence.json`）。已用精确目录权限断言和离线eval语法回归修复测试，不放宽角色权限、不修改生产broker绕过检查；两轮自身Docker资源也已清理。

最终整体审查发现的1项问题已修复并经定向复审通过：Docker start现在从原日志恢复批准目录，在审批/执行、执行器重开以及最终start（包括create后的首次start）前检查当前路径。目录、祖先或根被换成符号链接/私有目标、目录消失时拒绝启动，不重建容器/home/grant；inspect/list/stop仍可用。10项用例先RED后GREEN，加1项初次start回归及4项兼容测试，15/15通过。该修复不声称inode固定或原子文件系统到Docker挂载协议。

修复后再次完整`npm test`退出0：26项package通过，537项unit（535通过2跳过），320项Gate（312通过8跳过），49项runtime（45通过4跳过），构建/类型/分发校验通过。重新构建后的完整真实Docker闭环再次1/1通过，41.76秒，证据`/tmp/hcpi-DFQJjy/evidence.json`。新证据执行器bundle哈希与当前产物一致，23个原有容器均不变，共享runtime不变，全部自身Docker资源已清理，cleanupErrors为空。没有剩余源码审查问题；本记录不是当前生产Hub已开放创建的证据。

最终审查证据已关闭，结论Ready to merge: YES，但未合并/提交/推送/部署。测试后确认派生镜像无标签、无容器引用，仅删除本次`sha256:a765c3e1975b899621f676038104e7a035c419db563756ddf761dab28c754050`临时镜像，使用`--no-prune`保留基础镜像和其他资源。需要重跑真实验收时须先用示例Dockerfile重新准备镜像并指定其精确ID；历史报告中的临时ID不再代表当前已安装镜像。保留源码、开发分支和私有验收证据。

### 当前整体检查

- 完整`npm run build`成功，随后`npm run verify:dist`成功；只更新本地构建产物。
- `npm run test:unit`：526项，524通过、0失败、2项显式启用测试跳过。
- `npm run test:package`：26/26通过，覆盖真实打包/解包、自校验及独立入口。首次受限运行因`spawnSync EPERM`失败，批准临时子进程后重跑通过；不将环境限制冒充代码断言问题。
- `npm run test:socket`：110/110通过，真实临时Unix/HTTP/WebSocket、登记、配额、锁及CLI回归。
- 新功能真实Docker闭环1/1通过，另有3个安全护栏和1个eval语法回归通过；关闭opt-in时显式跳过，不误记为通过。
- 最后重新执行完整`npm test`退出0：构建+26项package通过、526项unit（524通过2跳过）、320项Gate（312通过8跳过）、49项runtime（45通过4跳过）。14项明确按运行条件跳过；真实新Docker闭环和110项socket已另行显式执行。最后`git diff --check`通过。

## 权限和功能边界

执行器若持有原始 Docker socket，是受信 daemon 管理权限主体；文件分角色不等于可以约束已被攻陷的执行器。公共入口、管理员HTTP服务、聊天服务和普通 Pi 不应获得该 socket。

新的注册方案要求 Chat/Pi 使用相同数字UID1000；签发IPC使用独立专用权限，配置/状态/导出文件不整体分享。宿主daemon bind坐标与执行器容器内路径必须分别配置。

现有 `pirun` 的QQ截图监听依赖宿主生命周期协调；静态只读挂载不等于已接入监听和最后消费者退出清理。未完成该集成时，不声称网页新建与交互式 `pirun` 完全等价。公网管理员HTTPS入口、真实付费模型、既有外部Pi接管以及版本/扩展更新都不由本次单项测试自动覆盖。
