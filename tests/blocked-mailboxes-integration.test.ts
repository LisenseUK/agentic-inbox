import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("blocking hides an inbox, drops mail and notifications, and unblocks without losing data", { timeout: 30_000 }, async () => {
	const bundle = await build({ entryPoints: ["tests/blocked-mailboxes-worker.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
		external: ["cloudflare:workers", "cloudflare:sockets", "node:*"], define: { "import.meta.env.DEV": "false" } });
	const mailbox = "quiet@snailbox.live", sibling = "quiet@lisense.uk", future = "future@snailbox.live";
	const discord: unknown[] = [], callbacks: { type?: string }[] = [];
	const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
		durableObjects: { MAILBOX: { className: "TestMailboxDO", useSQLite: true }, EMAIL_AGENT: { className: "TestEmailAgent", useSQLite: true } }, r2Buckets: ["BUCKET"],
		bindings: { DOMAINS: "lisense.uk,snailbox.live", EMAIL_ADDRESSES: [mailbox, sibling, future], MCP_PUBLIC_ORIGIN: "https://mail.lisense.uk", MCP_EVENTS_CALLBACK_HOSTS: "chatgpt.com", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test" },
		outboundService: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/v1/config") return Response.json({ domains: ["lisense.uk", "snailbox.live"] });
			if (url.hostname === "discord.com") { discord.push(await request.json()); return new Response(null, { status: 204 }); }
			assert.equal(url.hostname, "chatgpt.com");
			const body = await request.json() as { type?: string; challenge?: string }; callbacks.push(body);
			return Response.json(body.type === "verification" ? { challenge: body.challenge } : {});
		},
	});
	const request = (path: string, init?: RequestInit) => mf.dispatchFetch(`https://mail.lisense.uk${path}`, init);
	const jsonPost = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	async function rpc(method: string, params: Record<string, unknown>) {
		const response = await request("/mcp", { ...jsonPost({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "blocking-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
		} } }), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "MCP-Method": method, ...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}) } });
		return await response.json() as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
	}
	const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: { mailboxId: mailbox, ...args } });
	async function receive(to: string, subject: string) {
		const response = await request("/receive", { method: "POST", headers: { "X-Envelope-To": to },
			body: `From: sender@example.com\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\n\r\nHello` });
		assert.equal(response.status, 200, await response.text());
	}
	try {
		const settings = { fromName: "Keep my settings", autoReplyDrafting: false };
		for (const email of [mailbox, sibling]) assert.equal((await request("/api/v1/mailboxes", jsonPost({ email, name: "Quiet", settings }))).status, 201);
		await receive(mailbox, "Original message");
		const original = await (await request(`/api/v1/mailboxes/${mailbox}/emails?folder=inbox`)).json() as { emails: { id: string }[]; totalCount: number };
		assert.equal(original.totalCount, 1);
		const subscription = await rpc("events/subscribe", { name: "email.received", arguments: { mailboxId: mailbox }, delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/blocking-test", secret: "whsec_" + Buffer.alloc(32, 1).toString("base64") } });
		assert.ok(subscription.result, JSON.stringify(subscription));
		await receive(mailbox, "Queued notification");
		const state = `/event-state?mailbox=${encodeURIComponent(mailbox)}`;
		assert.deepEqual(await (await request(state)).json(), { subscriptions: 1, deliveries: 1 });
		assert.equal((await request("/api/v1/blocked-mailboxes", jsonPost({ email: mailbox.toUpperCase() }))).status, 200);
		assert.deepEqual(await (await request(state)).json(), { subscriptions: 0, deliveries: 0 });
		const beforeDiscord = discord.length, beforeCallbacks = callbacks.length;

		const visible = await (await request("/api/v1/mailboxes")).json() as { id: string }[];
		assert.deepEqual(visible.map((item) => item.id), [sibling]);
		const config = await (await request("/api/v1/config")).json() as { emailAddresses: string[] };
		assert.ok(!config.emailAddresses.includes(mailbox), "Configured inboxes cannot reappear through config");
		const blocked = await (await request("/api/v1/blocked-mailboxes")).json() as { email: string }[];
		assert.deepEqual(blocked.map((item) => item.email), [mailbox]);
		for (const path of ["", "/folders", "/emails?folder=inbox", `/emails/${original.emails[0].id}`, "/search?query=Original"]) {
			assert.equal((await request(`/api/v1/mailboxes/${mailbox}${path}`)).status, 404, path);
		}
		assert.equal((await request(`/api/v1/mailboxes/${mailbox}`, { method: "DELETE" })).status, 404);
		assert.equal((await request(`/api/v1/mailboxes/${mailbox}`, { ...jsonPost({ settings }), method: "PUT" })).status, 404);
		assert.equal((await request("/api/v1/mailboxes", jsonPost({ email: mailbox, name: "Recreate" }))).status, 404);
		const listed = await tool("list_mailboxes");
		assert.deepEqual(JSON.parse(listed.result!.content[0].text).map((item: { id: string }) => item.id), [sibling]);
		for (const name of ["list_emails", "search_emails", "send_email", "create_draft"]) {
			const response = await tool(name, { to: "recipient@example.com", subject: "Blocked", bodyHtml: "<p>Blocked</p>", query: "" });
			assert.equal(response.result?.isError, true, name);
		}
		assert.ok((await rpc("events/subscribe", { name: "email.received", arguments: { mailboxId: mailbox }, delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/blocking-test", secret: "whsec_" + Buffer.alloc(32, 1).toString("base64") } })).error);
		await receive(mailbox, "Must be discarded");
		await request(`/deliver-events?mailbox=${encodeURIComponent(mailbox)}`);
		assert.equal(discord.length, beforeDiscord, "Blocked inbox sends no Discord notifications");
		assert.equal(callbacks.length, beforeCallbacks, "Blocked inbox sends no MCP notifications");
		assert.equal((await (await request(`/agent-count?mailboxId=${mailbox}`)).json() as { count: number }).count, 0);
		const bucket = await mf.getR2Bucket("BUCKET");
		assert.equal(await bucket.get("test-last-send.json"), null, "Blocked sending never reaches the email provider");
		assert.ok(await bucket.head(`mailboxes/${mailbox}.json`), "Mailbox data is retained");
		assert.equal((await request("/api/v1/blocked-mailboxes", jsonPost({ email: future }))).status, 200);
		await receive(future, "Do not auto-create");
		assert.equal(await bucket.head(`mailboxes/${future}.json`), null);
		assert.equal((await request(`/api/v1/mailboxes/${sibling}`)).status, 200, "The same local part on the other domain remains available");

		assert.equal((await request(`/api/v1/blocked-mailboxes/${encodeURIComponent(mailbox)}`, { method: "DELETE" })).status, 200);
		const restored = await (await request(`/api/v1/mailboxes/${mailbox}`)).json() as { settings: Record<string, unknown> };
		assert.equal(restored.settings.fromName, settings.fromName); assert.equal(restored.settings.autoReplyDrafting, false);
		const restoredMail = await (await request(`/api/v1/mailboxes/${mailbox}/emails?folder=inbox`)).json() as { totalCount: number };
		assert.equal(restoredMail.totalCount, 2, "Blocking retains old mail and discards new mail");
		await request(`/deliver-events?mailbox=${encodeURIComponent(mailbox)}`);
		assert.equal(callbacks.length, beforeCallbacks, "Unblocking does not revive old subscriptions");
		assert.deepEqual(await (await request(state)).json(), { subscriptions: 0, deliveries: 0 });
		await receive(mailbox, "Mail after unblocking");
		assert.equal((await (await request(`/api/v1/mailboxes/${mailbox}/emails?folder=inbox`)).json() as { totalCount: number }).totalCount, 3);
		assert.equal((await tool("list_emails")).result?.isError, undefined);
		assert.equal((await request(`/api/v1/blocked-mailboxes/${encodeURIComponent(future)}`, { method: "DELETE" })).status, 200);
		await receive(future, "Create after unblocking");
		assert.ok(await bucket.head(`mailboxes/${future}.json`));
	} finally { await mf.dispose(); }
});
