#!/usr/bin/env node
import { main } from "../manager/main.ts";
await main(process.argv.slice(2), import.meta.url).catch(() => { process.stderr.write("Manager command failed; use --help and check private configuration\n"); process.exitCode = 1; });
