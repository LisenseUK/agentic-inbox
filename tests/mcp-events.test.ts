import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { MailboxEvents, type EventStorage } from "../workers/mcp/events-store";
import {
	callbackUrl, subscriptionSchema, signWebhook, subscriptionId, type EmailReceivedEvent,
	type EventPrincipal, type EventSubscriptionRequest,
} from "../workers/mcp/events-protocol";
import { handleModernMcp, isLegacyRequest } from "../workers/mcp/modern";
import type { Env } from "../workers/types";

function storage(database = new DatabaseSync(":memory:")) {
	let alarm: number | null = null;
	const adapter: EventStorage = {
		sql: { exec(query, ...values) {
			if (query.includes("CREATE TABLE")) { database.exec(query); return { toArray: () => [] }; }
			const statement = database.prepare(query);
			if (/^\s*SELECT/i.test(query)) return { toArray: () => statement.all(...values) as never[] };
			statement.run(...values); return { toArray: () => [] };
		} },
		transactionSync(callback) {
			database.exec("BEGIN");
			try { const value = callback(); database.exec("COMMIT"); return value; }
			catch (error) { database.exec("ROLLBACK"); throw error; }
		},
		async setAlarm(time) { alarm = time; }, async deleteAlarm() { alarm = null; },
	};
	return { adapter, database, get alarm() { return alarm; } };
}
const secret = "whsec_" + Buffer.alloc(32, 1).toString("base64");
const replacement = "whsec_" + Buffer.alloc(32, 2).toString("base64");
const owner = (): EventPrincipal => ({ id: "user-1", assertion: "test-assertion", expiresAt: Date.now() + 3_600_000 });
const request = (): EventSubscriptionRequest => subscriptionSchema.parse({
	name: "email.received", arguments: { mailboxId: "hello@lisense.uk" },
	delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/test", secret },
});
const event = (): EmailReceivedEvent => ({
	eventId: "evt_email_1", name: "email.received", timestamp: new Date().toISOString(), cursor: null,
	data: { mailboxId: "hello@lisense.uk", emailId: "email-1", threadId: "thread-1", from: "sender@example.com", subject: "Invoice received", preview: "A short message.", url: "https://mail.lisense.uk/mailbox/hello%40lisense.uk/emails/inbox" },
});
function fixture() {
	const state = storage();
	const posts: { body: Record<string, unknown>; headers: Headers; raw: string }[] = [];
	let status = 200, verificationStatus = 200, authorized = true, badChallenge = false;
	let verificationPaused: (() => Promise<void>) | undefined;
	const dependencies = {
		fetch: (async (_input, init) => {
			const raw = String(init?.body), body = JSON.parse(raw), headers = new Headers(init?.headers);
			assert.equal(init?.redirect, "manual");
			posts.push({ body, headers, raw });
			if (body.type === "verification") {
				await verificationPaused?.();
				return Response.json({ challenge: badChallenge ? "wrong" : body.challenge }, { status: verificationStatus });
			}
			return new Response(null, { status });
		}) as typeof fetch,
		authorized: async () => authorized,
	};
	return {
		state, dependencies, posts, store: new MailboxEvents(state.adapter, "chatgpt.com", dependencies),
		setStatus(value: number) { status = value; }, setVerificationStatus(value: number) { verificationStatus = value; }, setAuthorized(value: boolean) { authorized = value; },
		setBadChallenge() { badChallenge = true; }, pauseVerification(value: () => Promise<void>) { verificationPaused = value; },
	};
}
function count(f: ReturnType<typeof fixture>, table: string) { return f.state.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count; }

function verifySignature(post: ReturnType<typeof fixture>["posts"][number], key = secret) {
	const id = post.headers.get("webhook-id"), timestamp = post.headers.get("webhook-timestamp");
	const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${timestamp}.${post.raw}`).digest("base64");
	assert.ok(post.headers.get("webhook-signature")?.split(" ").includes(`v1,${signature}`));
}

test("Standard Webhooks signature covers exact serialized bytes", async () => {
	const body = '{"hello":"world"}';
	const expected = createHmac("sha256", Buffer.alloc(32, 1)).update(`evt_1.123.${body}`).digest("base64");
	assert.equal(await signWebhook(secret, "evt_1", 123, body), `v1,${expected}`);
});

test("callback restrictions reject private URLs, credentials, redirects to other hosts and lookalike hosts", () => {
	for (const url of ["http://chatgpt.com/hook", "https://127.0.0.1/hook", "https://[::1]/hook", "https://chatgpt.com.evil.test/hook", "https://user:pass@chatgpt.com/hook", "https://chatgpt.com:444/hook", "https://evil.test/hook", "https://chatgpt.com/hook#fragment"]) assert.throws(() => callbackUrl(url, "chatgpt.com,evil.test"));
	assert.equal(callbackUrl("https://chatgpt.com/hook", "chatgpt.com").hostname, "chatgpt.com");
});

test("subscription identity canonicalizes argument order and separates owners", async () => {
	const a = request(); a.arguments.from = "sender@example.com";
	const b = { ...a, arguments: { from: "sender@example.com", mailboxId: "hello@lisense.uk" } };
	assert.equal(await subscriptionId("user-1", a), await subscriptionId("user-1", b));
	assert.notEqual(await subscriptionId("user-1", a), await subscriptionId("user-2", a));
});

test("idempotent subscription, persisted delivery and unsubscribe across restart", async () => {
	const f = fixture();
	const first = await f.store.subscribe(owner(), request());
	const refreshed = await f.store.subscribe(owner(), request());
	assert.equal(first.id, refreshed.id); assert.equal(f.posts.length, 1); assert.equal(count(f, "mcp_event_subscriptions"), 1);
	verifySignature(f.posts[0]);
	f.store.enqueue(event());
	const restarted = new MailboxEvents(f.state.adapter, "chatgpt.com", f.dependencies);
	await restarted.alarm();
	assert.equal(f.posts.length, 2); assert.equal(f.posts[1].headers.get("webhook-id"), "evt_email_1");
	assert.equal(f.posts[1].headers.get("X-MCP-Subscription-Id"), first.id); verifySignature(f.posts[1]);
	assert.equal(count(f, "mcp_event_deliveries"), 0);
	await restarted.unsubscribe(owner(), request()); await restarted.unsubscribe(owner(), request());
	restarted.enqueue(event()); await restarted.alarm();
	assert.equal(f.posts.length, 2); assert.equal(count(f, "mcp_event_subscriptions"), 0);
});

test("mailbox, sender and case-insensitive subject filters are applied before queueing", async () => {
	const f = fixture(), args = request(); args.arguments.from = "sender@example.com"; args.arguments.subject_contains = "INVOICE";
	await f.store.subscribe(owner(), args);
	const wrongMailbox = event(); wrongMailbox.data.mailboxId = "another@lisense.uk"; f.store.enqueue(wrongMailbox);
	const wrongSender = event(); wrongSender.data.from = "other@example.com"; f.store.enqueue(wrongSender);
	const wrongSubject = event(); wrongSubject.data.subject = "News"; f.store.enqueue(wrongSubject);
	assert.equal(count(f, "mcp_event_deliveries"), 0);
	f.store.enqueue(event()); assert.equal(count(f, "mcp_event_deliveries"), 1);
});

test("queue writes roll back with the email transaction and filters use the full subject", async () => {
	const f = fixture(), args = request(); args.arguments.subject_contains = "invoice";
	await f.store.subscribe(owner(), args);
	const summary = event(); summary.data.subject = "a".repeat(1000);
	assert.throws(() => f.state.adapter.transactionSync(() => {
		f.store.enqueue(summary, summary.data.subject + " invoice");
		throw new Error("email save failed");
	}));
	assert.equal(count(f, "mcp_event_deliveries"), 0);
	f.store.enqueue(summary, summary.data.subject + " invoice");
	assert.equal(count(f, "mcp_event_deliveries"), 1);
});

test("invalid callback challenge and signing secret cannot activate a subscription", async () => {
	const f = fixture(); f.setBadChallenge();
	await assert.rejects(f.store.subscribe(owner(), request()), (e: { code: number }) => e.code === -32015);
	assert.equal(count(f, "mcp_event_subscriptions"), 0);
	const invalid = request(); invalid.delivery.secret = "whsec_aGVsbG8=";
	await assert.rejects(f.store.subscribe(owner(), invalid), (e: { code: number }) => e.code === -32602);
	assert.equal(f.posts.length, 1);
});

test("redirect responses never activate a callback or retry a delivery", async () => {
	const f = fixture(); f.setVerificationStatus(302);
	await assert.rejects(f.store.subscribe(owner(), request()), (error: { code: number }) => error.code === -32015);
	assert.equal(count(f, "mcp_event_subscriptions"), 0);
	f.setVerificationStatus(200); await f.store.subscribe(owner(), request());
	f.store.enqueue(event()); f.setStatus(302); await f.store.alarm();
	assert.equal(count(f, "mcp_event_deliveries"), 0);
});

test("retry keeps event ID and exact body and re-signs, and 410 removes the subscription", async () => {
	const f = fixture(); await f.store.subscribe(owner(), request()); f.store.enqueue(event());
	f.setStatus(503); await f.store.alarm();
	assert.equal(count(f, "mcp_event_deliveries"), 1);
	f.state.database.exec("UPDATE mcp_event_deliveries SET due_at = 0");
	f.setStatus(200); await f.store.alarm();
	assert.equal(f.posts[1].raw, f.posts[2].raw); assert.equal(f.posts[1].headers.get("webhook-id"), f.posts[2].headers.get("webhook-id")); verifySignature(f.posts[2]);
	assert.equal(count(f, "mcp_event_deliveries"), 0);
	f.store.enqueue(event()); f.setStatus(410); await f.store.alarm();
	assert.equal(count(f, "mcp_event_subscriptions"), 0);
});

test("413 is not retried and transient failures stop after bounded attempts", async () => {
	const f = fixture(); await f.store.subscribe(owner(), request()); f.store.enqueue(event());
	f.setStatus(413); await f.store.alarm(); assert.equal(count(f, "mcp_event_deliveries"), 0);
	f.store.enqueue(event()); f.setStatus(503);
	for (let i = 0; i < 8; i++) { f.state.database.exec("UPDATE mcp_event_deliveries SET due_at = 0"); await f.store.alarm(); }
	assert.equal(count(f, "mcp_event_deliveries"), 0);
});

test("expiry and revoked access stop queued deliveries, and lifetimes cannot exceed auth", async () => {
	const f = fixture(), args = request(), principal = owner(); args.ttlMs = null;
	const result = await f.store.subscribe(principal, args);
	assert.equal(Date.parse(result.refreshBefore), principal.expiresAt);
	f.store.enqueue(event()); f.setAuthorized(false); await f.store.alarm();
	assert.equal(f.posts.length, 1); assert.equal(count(f, "mcp_event_subscriptions"), 0);
	f.setAuthorized(true); await f.store.subscribe(owner(), request()); f.store.enqueue(event());
	f.state.database.exec("UPDATE mcp_event_subscriptions SET expires_at = 0"); await f.store.alarm();
	assert.equal(f.posts.length, 1); assert.equal(count(f, "mcp_event_deliveries"), 0);
});

test("signing key rotation verifies the new key and dual-signs during grace period", async () => {
	const f = fixture(); await f.store.subscribe(owner(), request());
	const updated = request(); updated.delivery.secret = replacement; await f.store.subscribe(owner(), updated);
	assert.equal(f.posts.length, 2); verifySignature(f.posts[1], replacement);
	f.store.enqueue(event()); await f.store.alarm(); verifySignature(f.posts[2], secret); verifySignature(f.posts[2], replacement);
});

test("requested TTL is honored and replay cursors are rejected", async () => {
	const f = fixture(), args = request(); args.ttlMs = 60_000;
	const started = Date.now(); const result = await f.store.subscribe(owner(), args);
	assert.ok(Date.parse(result.refreshBefore) <= Date.now() + 60_000);
	assert.ok(Date.parse(result.refreshBefore) >= started + 60_000);
	args.cursor = "old-position";
	await assert.rejects(f.store.subscribe(owner(), args), (error: { code: number }) => error.code === -32014);
});

test("another owner cannot cancel a subscription", async () => {
	const f = fixture(); await f.store.subscribe(owner(), request());
	await f.store.unsubscribe({ ...owner(), id: "another-user" }, request());
	assert.equal(count(f, "mcp_event_subscriptions"), 1);
});

test("unsubscribe while verification is pending prevents late activation", async () => {
	const f = fixture(); let release!: () => void, entered!: () => void;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	f.pauseVerification(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
	const pending = f.store.subscribe(owner(), request()); await waiting;
	await f.store.unsubscribe(owner(), request()); release();
	await assert.rejects(pending); assert.equal(count(f, "mcp_event_subscriptions"), 0);
});

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
function rpc(method: string, params: Record<string, unknown> = {}) {
	return new Request("https://mail.lisense.uk/mcp", { method: "POST", headers: {
		"Content-Type": "application/json", Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": "2026-07-28", "MCP-Method": method, "MCP-Name": typeof params.name === "string" ? params.name : "",
	}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }) });
}

test("MCP 2 discovery advertises events, event discovery and tools remain usable", async () => {
	const env = {} as Env;
	const discovery = await handleModernMcp(rpc("server/discover"), env, owner());
	assert.equal(discovery.status, 200);
	const body = await discovery.json() as { result: { capabilities: { events: object }; supportedVersions: string[] } };
	assert.deepEqual(body.result.capabilities.events, {}); assert.deepEqual(body.result.supportedVersions, ["2026-07-28"]);
	const catalog = await handleModernMcp(rpc("events/list"), env, owner());
	const listed = await catalog.json() as { result: { events: { name: string }[] } }; assert.equal(listed.result.events[0].name, "email.received");
	const tools = await handleModernMcp(rpc("tools/list"), env, owner());
	const toolList = await tools.json() as { result: { tools: { name: string }[] } };
	assert.ok(!toolList.result.tools.some((tool) => tool.name === "set_reply_drafting"));
	for (const name of ["list_mailboxes", "create_mailbox", "delete_mailbox", "get_attachment", "list_folders", "create_folder", "forward_email", "mark_thread_read", "star_email"]) {
		assert.ok(toolList.result.tools.some((tool) => tool.name === name), `${name} is discoverable`);
	}
});

test("events require an authenticated principal and legacy requests still route to the old handler", async () => {
	const denied = await handleModernMcp(rpc("events/list"), {} as Env);
	const body = await denied.json() as { error: { code: number } }; assert.equal(body.error.code, -32012);
	const legacy = new Request("https://mail.lisense.uk/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
	assert.equal(await isLegacyRequest(legacy), true); assert.equal(await isLegacyRequest(rpc("events/list")), false);
});
