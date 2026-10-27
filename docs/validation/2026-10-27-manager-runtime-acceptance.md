# Manager 本机运行验收（2026-10-27）

分支 `codex/manager-service`，验收起点 `6a0adc4`。本记录只覆盖本机测试，不是上线记录。

## 本轮授权

用户明确允许：仅在新建 `/tmp` 目录中启动临时 Pi、回环服务和浏览器，使用测试凭据与确定性模型验证接线和切换。不读取真实凭据、不使用生产卷、不操作已有容器／Hub／Gate／Pi／隧道；不包含下载、推送、合并或部署。

普通沙箱首次创建 Unix socket 报 `listen EPERM`。依据此次新的窄授权运行相同测试后，真实 HTTP 和 MCP 测试均执行并通过。此前“两次审核超时”的记录为历史状态，不再作为本轮未执行的理由。

## 已执行

| 检查 | 实际结果 | 证明边界 |
| --- | --- | --- |
| 公共／管理员 HTTP 共用只读官方目录、官方 MCP 工具严格参数 | 2/2 通过，零失败／跳过／取消，退出码 0 | 实际回环 HTTP、Unix IPC、官方 MCP SDK；registry 元数据为固定测试响应 |
| 现有真实浏览器桌面／手机任务闭环 | 1/1 通过，零失败／跳过／取消，退出码 0 | 1280×900／390×844，合成管理员／请求者凭据与夹具子进程，不是真实模型 |
| 增强后的真实浏览器版本目录与任务闭环 | 1/1 通过，零失败／跳过／取消，退出码 0 | 真实服务显示目录；匹配／无匹配搜索；目录查询不创建任务；退出清空目录；不依赖外网 registry |
| 实际三个 Pi 的候选切换，首次运行 | **失败**，退出码 1 | 三个既有会话的切换与后续生成断言已走完；最后新建会话立即读取尚未落盘的会话文件时报 ENOENT。不能把整项算作通过 |
| 修正前置条件后的实际候选切换 | **1/1 通过**，零失败／跳过／取消，退出码 0，188.9 秒 | 三个已对话的 Pi 从 1.1.0 切到 1.4.0；随后新建的消费者也实际生成并确认版本 |
| HTTP／MCP／真实浏览器组合回归 | **14/14 通过**，零失败／跳过／取消，退出码 0 | 包含认证、审批 CAS、重开、未知不重放、严格边界和版本目录查询；fixture Pi 不是实际模型 |
| 原生运行控制／协调器／等待／版本目录定向回归 | **68/68 通过**，零失败／跳过／取消，退出码 0 | 包含真实夹具 IPC 空闲观察器，另含明确标注的 FS-only 受控测试；不是 68 项实际候选程序切换 |
| 准备日志写入不确定故障 | **1/1 通过**，零失败／跳过／取消，退出码 0，103.0 秒 | 已实际完成真实候选证明后才注入；不以伪造证明替代 |
| 准备日志文件同步不确定故障 | **1/1 通过**，零失败／跳过／取消，退出码 0，98.8 秒 | 同上，覆盖 file-sync 边界 |
| 准备日志目录同步不确定故障 | **1/1 通过**，零失败／跳过／取消，退出码 0，94.6 秒 | 同上，覆盖 directory-sync 边界 |
| 类型检查、额外集成测试显式类型检查、分发一致性、diff 空白检查 | 退出码 0 | 不代替升级／回退或生产验收 |

真实浏览器使用已安装 Chromium headless shell 的独立临时 profile，页面请求仅放行两个测试回环 origin。增强测试只替换外部 HTTPS registry 边界，其余浏览器、HTTP、IPC、目录与任务执行器均是真实实现。

## 首次候选验收失败的核对

证据目录 `/tmp/nai-live-QJSh7Z` 保留。失败位于最后 `later` 消费者创建后的 `snapshotRuntime`，不是原有三个消费者的升级步骤。安装的 Pi `SessionManager.newSession` 会先分配 `sessionFile`，`_persist` 只在出现 user／assistant 对话时创建文件；原生后端的私有持久会话快照会核对文件存在与所有权。

测试现改为先让新建消费者通过真实确定性 provider 生成回复，再核对版本快照。没有人工创建会话文件，没有放宽后端文件／所有权验证，也没有删除原有三个会话的历史、进程身份、generation、后续生成或已选 Web／peer 防篡改断言。

这是测试前置条件修正，不宣称已经支持“无对话空会话”的更新。当前原生协调器需要可捕获的持久会话和非空 leaf；空会话／普通 Web 输入后的更新可用性仍需在完整任务接线中处理。

完整重跑保留 `/tmp/nai-live-QOwiL1`。实际 Node `v22.19.0`、ABI `127`；三个消费者为 `web`、`one`、`proof-one`。核对新 PID、generation 加一、版本为 1.4.0、原会话 ID／leaf／历史字节未变，旧 PID 已退出，各自继续生成正常；已选 Web 内容或 peer 链接变更时拒绝新建，恢复准确输入后新建消费者生成正常。最终仍为 `publicUpdates: false`。

独立定向审查（Cicero）只读检查两处测试改动，结论 PASS，无阻塞发现。审查明确认可延迟落盘的前置条件修正，且要求保留空会话未支持的限制；没有把静态审查算作运行验收或完整产品发布审查。

## 三种实际故障的结果

三次独立运行都先对三个持久对话消费者执行真实候选兼容性证明，再在准确的新测试根中注入未带错误码的日志写入／同步错误。每项都确认：

- 故障确实发生，激活返回 `ExecutionOutcomeUnknownError`。
- 在全部保护断言结束前，原进程没有 cancel／commit／stop 调用，精确进程身份和历史字节保留。
- 写入者锁、prepared 记录和 unknown 结果证据保留，选择修订号仍为 0。
- 后续生成／新建／停止／再次激活／协调器关闭均拒绝；不重放，也不自动取消输入隔离。
- 所有断言通过后，测试仅对记录的自有临时 backend 句柄做一次精确停止并确认成功；这不是对生产未知状态提供自动恢复。

证据根分别为 `/tmp/nai-live-0AGX7y`（write）、`/tmp/nai-live-fbx904`（file-sync）、`/tmp/nai-live-lc67Lg`（directory-sync）。磁盘证据保留，没有删除未知历史资源。上述最终验收命令均已结束、退出码 0；首次 EPERM 与 ENOENT 失败仍按原结果记录。测试自身的精确句柄清理已成功，没有本轮待处理的测试执行会话。

## 可重复的本轮命令

在本仓库运行，浏览器入口需显式选择本地已安装可执行文件；候选测试必须显式提供固定、已有的 candidate root、receipt hash 和独立 Web root。不能将生产 HOME／状态／配置传入。

```bash
PI_MANAGER_TEST_BROWSER=<本地浏览器可执行文件> \
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none \
  tests/manager-service.test.ts tests/manager-mcp.test.ts

node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none \
  tests/manager-native-activation.test.ts tests/native-runtime.test.ts \
  tests/manager-version-query.test.ts tests/manager-updates-catalog.test.ts \
  tests/manager-executor.test.ts tests/manager-waiting-idle.test.ts

# 在显式提供上述三项测试输入后分别运行：
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none \
  integration-tests/native-activation.test.ts
# 同一入口另分别设置 PI_MANAGER_TEST_PREPARED_JOURNAL_FAULT：
# write、file-sync、directory-sync；每次使用全新 /tmp 根。
```

这里只记录修复后 GREEN，未撤销源码修复再跑真实故障，故不宣称实际运行的故障 RED/GREEN 对照。首次 ENOENT 是本节所述测试前置条件失败，并非故障修复的 RED 证据。

## 交付边界

候选沿用本地已有、收据固定校验的官方 1.4.0；未下载新包，未调用 CandidateInstaller 的 Docker 安装入口。原生模式仅是可信本机开发，不证明敌对同 UID 的权限隔离。

即使这些检查全部通过，公开 `updates: false` 仍保留。完整审批队列中的更新／回退、Docker 不可变切换、扩展安装／更新／移除和最终交付验收尚未完成，不能据此称完整 Manager 已可发布。
