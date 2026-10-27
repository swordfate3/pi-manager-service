# 独立 Manager 远程提交准备（2026-10-27）

## 范围

开发工作区为 `pi-manager-service`，分支为 `codex/manager-service`，本次保存开发检查点并准备远程，不合并、不推送、不发布、不重新部署。该工作区是独立 Manager 仓库的 Git worktree，不属于 Pi Web 仓库。

检查点包括已有文档和验收辅助脚本的未提交改动、与当前源码匹配的构建产物，以及新增的独立 chat 构建入口。Manager 版本与扩展更新的完整任务接线仍未完成；公开更新能力维持关闭，不能把本次 commit 称为完整产品发布。

## 提交前检查

- 对提交准备时的453个已跟踪/未忽略文件运行基础敏感信息签名检查，未匹配私钥、GitHub/npm/Hugging Face Token 或 AWS Access Key 常见格式。该检查不是完整历史秘密审计。
- 不加入个人部署的 config/state/backup、.env、真实会话、凭据、Docker卷或 node_modules。补充相应根目录及常见生成文件的忽略规则，并实测个人配置与状态路径会被忽略。`.superpowers/`中以前已跟踪的开发报告没有删除或重写历史。
- `git diff --check` 和 `node scripts/manager-dist.mjs` 通过。README 区分代码能力、实际后端启用策略和开发预览状态。
- 使用现有 SSH 登录确认账号及远程访问正常；目标仓库首次只读检查没有分支。HTTPS认证返回401，不修改或保存Token，origin使用同一仓库的SSH地址。

## 新鲜验证结果

最终执行未经修改的 `npm test`，退出码0；其包含类型检查、Vite/Manager构建、构建清单生成及全部默认离线分组。

| 分组 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: |
| 包与分发检查 | 25 | 0 | 0 |
| TypeScript单元测试 | 490 | 2 | 0 |
| 遗留Gate离线测试 | 312 | 8 | 0 |
| 遗留runtime离线测试 | 45 | 4 | 0 |
| 合计 | 872 | 14 | 0 |

首次完整执行在Gate的ValidationFlow中有4项worker join(3)超时，整体命令失败，因此其runtime阶段未运行。没有修改产品实现、断言或超时：失败模块独立复跑9/9通过，带条件线程诊断的完整Gate复跑312通过/8跳过，再次原始 `npm test` 全部分组通过。首次问题尚未稳定复现，未确认根因；不能把它表述为已修复的产品缺陷。

本机日志保留在 `/tmp/pi-manager-commit-ckuSM93J/`：首次 `npm-test.log`、整组Gate复跑 `gate-diagnostic.log`、runtime独立复跑 `runtime-test.log`、最终完整 `npm-test-final.log`。这些临时日志不进入提交。

## 非本次验证范围

不下载官方候选，不调用真实模型，不重新执行真实升级/回退、浏览器或容器隔离验收，不操作运行中的服务/隧道/生产卷。跳过项和历史验收不能算成本轮通过项。私有候选模块已有成果不等于HTTP/MCP更新接线完成。
