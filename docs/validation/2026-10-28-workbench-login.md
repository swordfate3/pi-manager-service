# 工作台登录/SQLite/缓存交付记录

## 范围

2026-10-28（Asia/Shanghai）。用户明确批准设计后连续开发，不中途增加审批。
仅更新本地工作台，不切换阿里云/Caddy/SSH隧道，不改 Pi 镜像、卷和工作区。
没有提交或推送；保留原先脏工作树。账号由用户首次访问本机页面设置，没有默认密码。

## 实现

- 单账号登录、用户名/密码修改、退出当前/全部设备、隐藏终端初始化和忘记密码恢复。
- SQLite持久保存账号摘要、会话哈希、实例元数据、最近使用目录和有界安全事件。
- 旧runs.json原样备份、事务导入一次，之后SQLite是唯一写入源；保留旧文件。
- 管理、会话、下载及WS完整认证。原有原始pirun行为、五个共享卷、截图和工作区绑定不变。
- HTTPS模式显式publicOrigin，Secure/HttpOnly Cookie，禁止远程网页首次注册；不信任代理断言。
- 代理隔离Cookie/Authorization/身份头与下游Set-Cookie；退出/撤销清理WS。
- 目录2秒/64项缓存，启动重新校验；工作台JS私有ETag；认证/HTML/API/聊天no-store。

## 证据

基线35/35通过。新增store/auth/cookie/cache/race测试先失败再实现；恢复CLI和安装器增加独立回归。
两项独立安全审查P2均已修复，并经窄范围复核关闭：共享代理来源长期封锁正确登录，及101前断连的代理资源泄漏（包括FIN半关闭）。

最终运行：

- `npm run build`：PASS，包含typecheck；`npm run verify:dist`：PASS。
- `npm run test:unit`：614项，608 PASS，6项按条件跳过，0 FAIL。
- `npm run test:package`：27 PASS，0 FAIL，包括安装器备份SQLite及用户配置保留。
- 显式Chromium执行 `node --import ./tests/register-ts.mjs --test --test-concurrency=1 tests/local-*.test.ts`：69 PASS，0跳过，0失败。
- 真实临时HTTP/Unix registry/Hub/fake-Pi链路验证HTTP与下载、WS echo、错误Origin、Cookie不泄漏、logout/all和外部DB撤销关闭连接、晚握手不保留活连接。没有调用模型或操作生产卷。
- 实际Chromium验证首次设置、登录、改密码、重新登录、退出，320/390/1280布局及原工作台浏览启动行为。
- 隔离目录服务端计时：cold 1.18ms，warm20次p50 0.31ms/p95 0.70ms；仅是小临时目录的服务器耗时，不是公网、Docker或模型速度保证。

日志：`/tmp/pi-manager-login-{unit-final,focused-final,package,build}.log`。
初版失败测试和审查历史保留；最终通过以本节所列最后运行结果为准。

## 本地部署

部署前确认实例全部stopped，Docker只有原四角色容器运行。安装器先备份旧程序、配置、脚本；重启的仅是`pi-local-workbench.service`。

备份：`/home/fate/docker_files/pi-stack/backup/local-workbench-2026-10-27T17-57-31-741Z`（目录时间为UTC，对应本地10月28日）。

运行目录：`/home/fate/docker_files/pi-stack/local-workbench`。
入口：`http://127.0.0.1:18403/`。内部Hub18404仍为受信任回环入口，不能绕过外层直接暴露公网。

只读实时验收：`deploy/local/verify-local-login.mjs /tmp/pi-login-smoke-20261028` PASS。

- `/`302到登录页；管理状态、会话列表、脚本和模拟文件路径未认证401；登录页200。
- 实际浏览器1280/390宽度无脚本异常、无横向溢出；没有提交账号/密码。
- SQLite 49,152字节（48KiB），权限0600，2条旧实例记录，账号0个待用户初始化。
- 本地程序与构建SHA256一致：`88a7ed7295e52b20086e369ee636d67ec728ea690873c3793d8a573693985d38`。
- 4个原有运行容器的ID/启动时间/重启计数全部不变。
- `pi-dockerctl local password`已进入统一入口帮助；没有改原pirun入口、Pi模型或扩展。

## 使用与边界

访问本地入口，设置自己的用户名及至少12字符密码；登录后选目录→启动。右上角“账号与退出”可修改密码或退出。
忘记密码执行 `pi-dockerctl local password`，密码不传到对话，不放进命令参数。
关网页/退出登录不会停Pi，停止仍使用原工作台按钮。

公网尚未切换；HTTPS认证模式在隔离测试验证，并非已完成阿里云/真实手机公网验收。
这是可信宿主单账号控制台，不声称能隔离同UID恶意宿主进程或恶意已安装扩展。
SQLite在Node22仍有实验性提示，本方案不引入原生npm依赖或额外数据库容器。
