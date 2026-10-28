#!/usr/bin/env node
import { startLocalService } from "../manager/local-service.ts";
import { readPrivateJson } from "../manager/config.ts";
import { configArgument, runProcess } from "../manager/process-entry.ts";
import { resetLocalAccount, terminalQuestion } from "../manager/local-account-cli.ts";
const args=process.argv.slice(2);
if(args.length === 1 && args[0] === "--help") {
  process.stdout.write("Pi 工作台\n  --config FILE                     启动（默认启用登录）\n  account-reset --config FILE        本机终端初始化/重置账号，撤销所有登录\n首次本机网页可直接设置账号；HTTPS模式不提供网页初始化。密码不会作为命令参数。\n");
} else if(args[0] === "account-reset") {
  try {await resetLocalAccount(await readPrivateJson(configArgument(args.slice(1))),terminalQuestion);process.stdout.write("账号已保存，旧登录已撤销。请到网页登录。\n");}
  catch {process.stderr.write("账号未修改：请在本机交互终端输入有效用户名及至少12字符、两次一致的新密码。\n");process.exitCode=1;}
} else await runProcess(async () => startLocalService(await readPrivateJson(configArgument(args))));
