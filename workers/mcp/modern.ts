// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMcpHandler, isLegacyRequest, McpServer, ProtocolError, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Env } from "../types";
import {
	eventDefinition, subscriptionSchema, unsubscribeSchema, type EventPrincipal,
} from "./events-protocol";
import { registerEmailTools } from "./tools";
import { isMailboxActive } from "../lib/mailbox-access";

export { isLegacyRequest };

/** A fresh SDK server for each modern request; durable state lives in mailboxes. */
export async function handleModernMcp(request: Request, env: Env, principal?: EventPrincipal): Promise<Response> {
	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: "agentic-inbox", version: "2.0.0" }, {
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		});
		registerEmailTools((name, description, shape, callback) => {
			const schema = z.object(shape);
			const compatibleSchema: StandardSchemaWithJSON<z.input<typeof schema>, z.output<typeof schema>> = {
				"~standard": { ...schema["~standard"], jsonSchema: {
					input: () => toJsonSchemaCompat(schema), output: () => toJsonSchemaCompat(schema),
				} },
			};
			server.registerTool(name, { description, inputSchema: compatibleSchema }, async (args) => {
				const result = await callback(schema.parse(args));
				return { content: result.content, isError: result.isError, structuredContent: result.structuredContent };
			});
		}, env);
		const requirePrincipal = () => {
			if (!principal || principal.expiresAt <= Date.now()) throw new ProtocolError(-32012, "Authenticated user required");
			return principal;
		};
		server.server.setRequestHandler("events/list", { params: z.object({ cursor: z.string().optional() }).passthrough() }, async (params) => {
			requirePrincipal();
			if (params.cursor) throw new ProtocolError(-32602, "Unknown event catalog cursor");
			return { events: [eventDefinition] };
		});
		server.server.setRequestHandler("events/subscribe", { params: subscriptionSchema }, async (params) => {
			const owner = requirePrincipal();
			if (!await isMailboxActive(env, params.arguments.mailboxId)) throw new ProtocolError(-32012, "Mailbox not found");
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(params.arguments.mailboxId));
			const outcome = await stub.subscribeMcpEvent(owner, params);
			if (outcome.error) throw new ProtocolError(outcome.error.code, outcome.error.message, outcome.error.data);
			if (!outcome.result) throw new ProtocolError(-32603, "Subscription failed");
			return { ...outcome.result };
		});
		server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeSchema }, async (params) => {
			const owner = requirePrincipal();
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(params.arguments.mailboxId));
			await stub.unsubscribeMcpEvent(owner, params);
			return {};
		});
		return server;
	}, { legacy: "reject", maxRequestBodySize: 1024 * 1024 });
	try {
		const response = await handler.fetch(request);
		// The draft Events capability is removed by the SDK's closed capability
		// schema. Decorate only a successful, validated discovery response.
		if (principal && request.headers.get("MCP-Method") === "server/discover" && response.ok
			&& response.headers.get("content-type")?.includes("application/json")) {
			const body = await response.json() as { result?: { capabilities?: Record<string, unknown> } };
			if (body.result?.capabilities) body.result.capabilities.events = {};
			const headers = new Headers(response.headers);
			headers.delete("content-length");
			return Response.json(body, { status: response.status, headers });
		}
		return response;
	}
	finally { await handler.close(); }
}
