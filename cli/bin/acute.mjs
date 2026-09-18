#!/usr/bin/env node
/**
 * The `acute` bin shim (CLI-DESIGN §3): a tiny loader that imports the
 * compiled entry (dist/main.js) and exits with its returned code. Everything
 * interesting lives in TypeScript under src/ — this file must stay
 * dependency-free and trivial so the packaged bin never breaks before the
 * real code even loads.
 */
import { run } from "../dist/main.js";

process.exitCode = await run(process.argv.slice(2));
