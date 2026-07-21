#!/usr/bin/env bun
import { toolDefinitions } from "../server/index.mjs";

for (const tool of toolDefinitions) console.log(tool.name);
