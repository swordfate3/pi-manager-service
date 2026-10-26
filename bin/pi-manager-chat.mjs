#!/usr/bin/env node
import { startChatService } from "../manager/chat-service.ts";
import { configArgument, runProcess } from "../manager/process-entry.ts";
await runProcess(async () => startChatService(configArgument(process.argv.slice(2))));
