#!/usr/bin/env node
import { startAdminService } from "../manager/admin-service.ts";
import { readPrivateJson } from "../manager/config.ts";
import { configArgument, runProcess } from "../manager/process-entry.ts";
await runProcess(async () => startAdminService(await readPrivateJson(configArgument(process.argv.slice(2)))));
