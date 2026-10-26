#!/usr/bin/env node
import { startExecutor } from "../manager/executor/main.ts";
import { readPrivateJson } from "../manager/config.ts";
import { configArgument, runProcess } from "../manager/process-entry.ts";
await runProcess(async () => startExecutor(await readPrivateJson(configArgument(process.argv.slice(2)))));
