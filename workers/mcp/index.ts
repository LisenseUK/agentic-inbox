// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../types";
import { registerEmailTools } from "./tools";

/** Session-based MCP endpoint retained for existing clients. */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({ name: "agentic-inbox", version: "1.0.0" });

	async init() {
		registerEmailTools((name, description, shape, handler) => {
			const schema = z.object(shape);
			this.server.registerTool(name, { description, inputSchema: schema }, async (args) => handler(schema.parse(args)));
		}, this.env);
	}
}
