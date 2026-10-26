#!/usr/bin/env node
import { startService } from "../manager/service.ts";
import { readPrivateJson } from "../manager/config.ts";
import { configArgument, runProcess } from "../manager/process-entry.ts";
await runProcess(async () => startService(await readPrivateJson(configArgument(process.argv.slice(2)))));
