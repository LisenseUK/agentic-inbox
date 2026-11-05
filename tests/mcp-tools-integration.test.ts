import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("MCP searches, attachments, folders, thread actions and forwarding use real mailbox storage", { timeout: 30_000 }, async () => {
	const bundled = await build({ entryPoints: ["tests/mcp-events-worker.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
		external: ["cloudflare:workers", "cloudflare:sockets", "node:*"], define: { "import.meta.env.DEV": "false" }, });
	const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
		durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true }, EMAIL_AGENT: { className: "TestEmailAgent", useSQLite: true } }, r2Buckets: ["BUCKET"],
		bindings: { MCP_PUBLIC_ORIGIN: "https://mail.lisense.uk", DOMAINS: "lisense.uk", EMAIL_ADDRESSES: [] },
	});
	const mailboxId = "features@lisense.uk";
	async function call(name: string, args: Record<string, unknown> = {}) {
		const response = await mf.dispatchFetch("https://mail.lisense.uk/mcp", { method: "POST", headers: {
			"Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "MCP-Method": "tools/call", "MCP-Name": name,
		}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { mailboxId, ...args }, _meta: {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
		} } }) });
		const body = await response.json() as { result?: { isError?: boolean; content: { type: string; text?: string; resource?: { blob: string; mimeType: string } }[] }; error?: unknown };
		assert.ok(body.result || body.error, JSON.stringify(body));
		let data;
		try { data = body.result?.content[0].text ? JSON.parse(body.result.content[0].text) : undefined; }
		catch { data = body.result?.content[0].text; }
		return { ...body.result, rpcError: body.error, data };
	}
	try {
		assert.equal((await mf.dispatchFetch("https://mail.lisense.uk/seed-features")).status, 200);
		const page = await call("search_emails", { from: "accounts@", subject: "Invoice", is_read: false, page: 2, limit: 1 });
		assert.equal(page.data.totalCount, 2); assert.equal(page.data.page, 2); assert.equal(page.data.limit, 1);
		assert.deepEqual(page.data.emails.map((item: { id: string }) => item.id), ["email-1"]);
		assert.equal((await call("search_emails", { query: "attached", has_attachment: true, to: "finance@", date_start: "2026-10-10T00:00:00Z", date_end: "2026-10-10T23:59:59Z" })).data.totalCount, 1);
		assert.equal((await call("search_emails", { has_attachment: false })).data.totalCount, 2);
		assert.equal((await call("search_emails", { date_start: "2026-10-11T00:00:00Z", date_end: "2026-10-10T00:00:00Z" })).isError, true);
		const invalid = await call("search_emails", { limit: 101 });
		assert.ok(invalid.isError || invalid.rpcError, "Invalid page sizes are rejected");

		const file = await call("get_attachment", { emailId: "email-1", attachmentId: "file-1" });
		assert.ok(!file.isError); assert.equal(file.data.filename, "invoice.txt");
		assert.equal(file.content![1].resource!.mimeType, "text/plain");
		assert.deepEqual([...Buffer.from(file.content![1].resource!.blob, "base64")], [0, 1, 2, 65, 66, 67, 255]);
		assert.equal((await call("get_attachment", { emailId: "email-2", attachmentId: "file-1" })).isError, true, "Attachment must belong to requested email");
		assert.equal((await call("get_attachment", { mailboxId: "missing@lisense.uk", emailId: "email-1", attachmentId: "file-1" })).isError, true);

		assert.equal((await call("star_email", { emailId: "email-1", starred: true })).data.starred, true);
		assert.equal((await call("search_emails", { is_starred: true })).data.totalCount, 1);
		assert.equal((await call("star_email", { emailId: "email-1", starred: false })).data.starred, false);
		assert.equal((await call("star_email", { emailId: "missing", starred: true })).isError, true);
		assert.equal((await call("mark_thread_read", { threadId: "thread-1" })).data.markedRead, true);
		assert.equal((await call("search_emails", { is_read: true })).data.totalCount, 2);
		assert.equal((await call("mark_thread_read", { threadId: "missing" })).isError, true);

		const folder = await call("create_folder", { name: "Invoices 2026" });
		assert.equal(folder.data.id, "invoices-2026");
		assert.equal((await call("create_folder", { name: "Invoices 2026" })).isError, true);
		assert.equal((await call("create_folder", { name: "!!!" })).isError, true);
		assert.ok(!(await call("move_email", { emailId: "email-1", folderId: folder.data.id })).isError);
		assert.equal((await call("search_emails", { folder: folder.data.id })).data.totalCount, 1);
		const folders = await call("list_folders");
		assert.equal(folders.data.find((item: { id: string }) => item.id === folder.data.id).name, "Invoices 2026");

		const forwarded = await call("forward_email", { emailId: "email-1", to: "recipient@example.com", bodyHtml: "<p>Please review.</p>" });
		assert.ok(!forwarded.isError, JSON.stringify(forwarded)); assert.equal(forwarded.data.status, "sent");
		const bucket = await mf.getR2Bucket("BUCKET");
		const sent = await (await bucket.get("test-last-send.json"))!.json<{ html: string; subject: string; attachments?: { bytes: number[] }[] }>();
		assert.match(sent.html, /Please review/); assert.match(sent.html, /Invoice attached/); assert.equal(sent.subject, "Fwd: Invoice Alpha");
		assert.deepEqual(sent.attachments![0].bytes, [0, 1, 2, 65, 66, 67, 255], "Provider receives decoded binary bytes");
		const saved = await call("get_email", { emailId: forwarded.data.id });
		assert.equal(saved.data.folder_id, "sent"); assert.notEqual(saved.data.thread_id, "thread-1");
		assert.equal(saved.data.attachments.length, 1);
		const savedFile = await call("get_attachment", { emailId: forwarded.data.id, attachmentId: saved.data.attachments[0].id });
		assert.equal(savedFile.content![1].resource!.blob, file.content![1].resource!.blob);
		await bucket.put("attachments/email-1/file-1/invoice.txt", new Uint8Array(5 * 1024 * 1024 + 1));
		assert.equal((await call("get_attachment", { emailId: "email-1", attachmentId: "file-1" })).isError, true, "Oversized attachments return a useful error");
		await bucket.delete("attachments/email-1/file-1/invoice.txt");
		assert.equal((await call("get_attachment", { emailId: "email-1", attachmentId: "file-1" })).isError, true);
		assert.equal((await call("forward_email", { emailId: "email-1", to: "recipient@example.com" })).isError, true, "Missing attachment files prevent partial forwarding");
		await bucket.put("attachments/email-1/file-1/invoice.txt", new Uint8Array([0, 1, 2, 65, 66, 67, 255]));

		assert.ok(!(await call("forward_email", { emailId: "email-1", to: "recipient@example.com", includeAttachments: false })).isError);
		assert.deepEqual((await (await bucket.get("test-last-send.json"))!.json<{ attachments?: unknown[] }>()).attachments, undefined);
		const before = (await call("search_emails", { folder: "sent" })).data.totalCount;
		assert.equal((await call("forward_email", { emailId: "email-1", to: "fail@example.com" })).isError, true);
		assert.equal((await call("search_emails", { folder: "sent" })).data.totalCount, before, "Failed delivery never creates a Sent message");
		const httpForward = await mf.dispatchFetch(`https://mail.lisense.uk/api/v1/mailboxes/${mailboxId}/emails/email-1/forward`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
				to: "recipient@example.com", from: mailboxId, subject: "Fwd: Invoice", html: "<p>HTTP forward</p>",
				attachments: [{ filename: "test.bin", type: "application/octet-stream", disposition: "attachment", content: "AAE=" }],
			}),
		});
		assert.equal(httpForward.status, 202);
		const httpPayload = await (await bucket.get("test-last-send.json"))!.json<{ attachments: { bytes: number[] }[] }>();
		assert.deepEqual(httpPayload.attachments[0].bytes, [0, 1]);
		const mismatchedSender = await mf.dispatchFetch(`https://mail.lisense.uk/api/v1/mailboxes/${mailboxId}/emails/email-1/forward`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
				to: "recipient@example.com", from: "other@lisense.uk", subject: "Fwd", text: "Test",
			}),
		});
		assert.equal(mismatchedSender.status, 400);
		assert.equal((await call("forward_email", { emailId: "missing", to: "recipient@example.com" })).isError, true);
	} finally { await mf.dispose(); }
});
