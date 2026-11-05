import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createHmac } from "node:crypto";

test("inbound mail, MCP events, inbox management and reply drafting work with real Durable Objects", { timeout: 30_000 }, async () => {
	const bundled = await build({ entryPoints: ["tests/mcp-events-worker.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
		external: ["cloudflare:workers", "cloudflare:sockets", "node:*"], define: { "import.meta.env.DEV": "false" }, });
	const posts: { body: Record<string, unknown>; raw: string; headers: Record<string, string> }[] = [];
	let delivered!: () => void;
	const eventDelivered = new Promise<void>((resolve) => { delivered = resolve; });
	const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
		durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true }, EMAIL_AGENT: { className: "TestEmailAgent", useSQLite: true } }, r2Buckets: ["BUCKET"],
		bindings: { MCP_EVENTS_CALLBACK_HOSTS: "chatgpt.com", MCP_PUBLIC_ORIGIN: "https://mail.lisense.uk", DOMAINS: "lisense.uk", EMAIL_ADDRESSES: ["hello@lisense.uk", "new@lisense.uk"] }, outboundService: async (request) => {
			const url = new URL(request.url);
			if (url.origin === "https://mail.lisense.uk" && url.pathname === "/api/v1/config") {
				assert.equal(request.headers.get("cookie"), "CF_Authorization=test-assertion");
				return Response.json({ domains: ["lisense.uk"] });
			}
			assert.equal(url.href, "https://chatgpt.com/mcp-events/test");
			const raw = await request.text(), body = JSON.parse(raw);
			const headers = Object.fromEntries(request.headers.entries());
			posts.push({ body, raw, headers });
			if (body.type !== "verification") delivered();
			return Response.json(body.type === "verification" ? { challenge: body.challenge } : {});
		},
	});
	const secret = "whsec_" + Buffer.alloc(32, 1).toString("base64");
	async function rpc(method: string, params: Record<string, unknown> = {}) {
		return mf.dispatchFetch("https://mail.lisense.uk/mcp", { method: "POST", headers: {
			"Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "MCP-Method": method,
			...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}),
		}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
		} } }) });
	}
	try {
		assert.equal((await mf.dispatchFetch("https://mail.lisense.uk/seed")).status, 200);
		const subscribed = await rpc("events/subscribe", { name: "email.received", arguments: { mailboxId: "hello@lisense.uk" }, delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/test", secret }, cursor: null });
		const sub = await subscribed.json() as { result?: { id: string }; error?: unknown };
		assert.ok(sub.result, JSON.stringify({ ...sub, posted: posts.map(p => Object.keys(p.body)) }));
		assert.equal(posts.length, 1);
		const mail = "From: Sender <sender@example.com>\r\nTo: hello@lisense.uk\r\nSubject: New invoice\r\nMessage-ID: <invoice@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHere is your invoice.\r\n";
		const received = await mf.dispatchFetch("https://mail.lisense.uk/receive", { method: "POST", headers: { "X-Envelope-To": "hello@lisense.uk" }, body: mail });
		assert.equal(received.status, 200, await received.text());
		await eventDelivered;
		const post = posts[1];
		assert.equal(post.body.name, "email.received");
		assert.equal(post.headers["x-mcp-subscription-id"], sub.result!.id);
		const signature = createHmac("sha256", Buffer.alloc(32, 1)).update(`${post.headers["webhook-id"]}.${post.headers["webhook-timestamp"]}.${post.raw}`).digest("base64");
		assert.equal(post.headers["webhook-signature"], `v1,${signature}`);
		const data = post.body.data as { mailboxId: string; emailId: string; subject: string; preview: string };
		assert.equal(data.mailboxId, "hello@lisense.uk"); assert.equal(data.subject, "New invoice"); assert.equal(data.preview, "Here is your invoice.");
		const email = await rpc("tools/call", { name: "get_email", arguments: { mailboxId: data.mailboxId, emailId: data.emailId } });
		const emailResult = await email.json() as { result?: { isError?: boolean }; error?: unknown };
		assert.ok(emailResult.result, JSON.stringify(emailResult)); assert.ok(!emailResult.result.isError);
		const stopped = await rpc("events/unsubscribe", { name: "email.received", arguments: { mailboxId: data.mailboxId }, delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/test" } });
		assert.ok((await stopped.json() as { result?: unknown }).result);

		async function callTool(name: string, args: Record<string, unknown>) {
			const response = await rpc("tools/call", { name, arguments: args });
			const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
			assert.ok(body.result, JSON.stringify(body));
			return { ...body.result, data: JSON.parse(body.result.content[0].text) };
		}
		const created = await callTool("create_mailbox", { email: "NEW@lisense.uk", name: "New inbox" });
		assert.ok(!created.isError);
		assert.equal(created.data.id, "new@lisense.uk");
		assert.equal(created.data.settings.autoReplyDrafting, true);
		assert.equal((await callTool("create_mailbox", { email: "new@lisense.uk", name: "Duplicate" })).isError, true);
		assert.equal((await callTool("create_mailbox", { email: "blocked@example.com", name: "Blocked" })).isError, true);
		const newMail = mail.replace("hello@lisense.uk", "new@lisense.uk");
		const countUrl = "https://mail.lisense.uk/agent-count?mailboxId=new@lisense.uk";
		const bucket = await mf.getR2Bucket("BUCKET");
		const settings = created.data.settings;
		const settingsUrl = "https://mail.lisense.uk/api/v1/mailboxes/new@lisense.uk";
		assert.equal((await mf.dispatchFetch(settingsUrl, { method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { ...settings, autoReplyDrafting: "false" } }) })).status, 400);
		assert.equal((await mf.dispatchFetch(settingsUrl, { method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { ...settings, autoReplyDrafting: false } }) })).status, 200);
		assert.equal((await mf.dispatchFetch("https://mail.lisense.uk/receive", { method: "POST", headers: { "X-Envelope-To": "new@lisense.uk" }, body: newMail })).status, 200);
		assert.equal((await (await mf.dispatchFetch(countUrl)).json() as { count: number }).count, 0);
		const emails = await callTool("list_emails", { mailboxId: "new@lisense.uk", folder: "inbox" });
		assert.ok(!emails.isError);
		assert.equal(emails.data.length, 1, "Disabling drafting still stores inbound email");
		const saved = await (await bucket.get("mailboxes/new@lisense.uk.json"))!.json<{ fromName: string; autoReplyDrafting: boolean }>();
		assert.equal(saved.fromName, "New inbox");
		assert.equal(saved.autoReplyDrafting, false);
		assert.equal((await mf.dispatchFetch(settingsUrl, { method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { ...settings, autoReplyDrafting: true } }) })).status, 200);
		assert.equal((await mf.dispatchFetch("https://mail.lisense.uk/receive", { method: "POST", headers: { "X-Envelope-To": "new@lisense.uk" }, body: newMail })).status, 200);
		let count = 0;
		for (let attempt = 0; attempt < 20 && count === 0; attempt++) {
			count = (await (await mf.dispatchFetch(countUrl)).json() as { count: number }).count;
			if (!count) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(count, 1, "Enabling drafting triggers the agent");
		assert.ok(!(await callTool("delete_mailbox", { mailboxId: "NEW@lisense.uk" })).isError);
		assert.equal(await bucket.head("mailboxes/new@lisense.uk.json"), null);
		assert.equal((await callTool("list_emails", { mailboxId: "new@lisense.uk", folder: "inbox" })).isError, true);
		assert.equal((await callTool("delete_mailbox", { mailboxId: "new@lisense.uk" })).isError, true);
		const recreated = await callTool("create_mailbox", { email: "new@lisense.uk", name: "Recreated" });
		assert.equal(recreated.data.settings.autoReplyDrafting, true, "Drafting defaults to enabled");

	} finally { await mf.dispose(); }
});
