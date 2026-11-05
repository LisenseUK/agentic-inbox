import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("mailboxes on both domains route by delivery address and send independently", { timeout: 30_000 }, async () => {
	const bundled = await build({
		entryPoints: ["tests/mcp-events-worker.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
		external: ["cloudflare:workers", "cloudflare:sockets", "node:*"], define: { "import.meta.env.DEV": "false" },
	});
	const mailboxes = ["hello@lisense.uk", "hello@snailbox.live"];
	const automaticMailboxes = ["first@lisense.uk", "first@snailbox.live"];
	for (const restricted of [false, true]) {
		const mf = new Miniflare({
			modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
			durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true }, EMAIL_AGENT: { className: "TestEmailAgent", useSQLite: true } },
			r2Buckets: ["BUCKET"],
			bindings: { MCP_PUBLIC_ORIGIN: "https://mail.lisense.uk", DOMAINS: "lisense.uk,snailbox.live", EMAIL_ADDRESSES: restricted ? [...mailboxes, ...automaticMailboxes] : [] },
		});
		const request = (path: string, init?: RequestInit) => mf.dispatchFetch(`https://mail.lisense.uk${path}`, init);
		const inbox = async (mailbox: string) => {
			const response = await request(`/api/v1/mailboxes/${mailbox}/emails?folder=inbox`);
			assert.equal(response.status, 200);
			return await response.json() as { emails: { id: string; subject: string; recipient: string }[] };
		};
		const deliver = async (to: string, subject: string, recipientHeaders: string) => {
			const response = await request("/receive", {
				method: "POST", headers: { "X-Envelope-To": to },
				body: `From: sender@example.com\r\n${recipientHeaders}Subject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello.\r\n`,
			});
			assert.equal(response.status, 200, await response.text());
		};
		try {
			const config = await (await request("/api/v1/config")).json() as { domains: string[] };
			assert.deepEqual(config.domains, ["lisense.uk", "snailbox.live"]);
			for (const email of mailboxes) {
				const created = await request("/api/v1/mailboxes", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, name: "Hello", settings: { autoReplyDrafting: false } }),
				});
				assert.equal(created.status, 201, await created.text());
			}
			const listed = await (await request("/api/v1/mailboxes")).json() as { id: string }[];
			assert.deepEqual(listed.map((mailbox) => mailbox.id).sort(), [...mailboxes].sort());
			for (const mailbox of automaticMailboxes) {
				assert.equal((await request(`/api/v1/mailboxes/${mailbox}`)).status, 404);
				await Promise.all([
					deliver(mailbox.toUpperCase(), "First delivery", "To: other@example.com\r\n"),
					deliver(mailbox, "Concurrent delivery", ""),
				]);
				assert.equal((await inbox(mailbox)).emails.length, 2);
				const created = await (await request(`/api/v1/mailboxes/${mailbox}`)).json() as { settings: { fromName: string; autoReplyDrafting: boolean } };
				assert.equal(created.settings.fromName, "first");
				assert.equal(created.settings.autoReplyDrafting, true);
				const settings = { ...created.settings, fromName: "Custom name", autoReplyDrafting: false };
				assert.equal((await request(`/api/v1/mailboxes/${mailbox}`, {
					method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }),
				})).status, 200);
				await deliver(mailbox, "Later delivery", `To: ${mailbox}\r\n`);
				assert.equal((await inbox(mailbox)).emails.length, 3);
				const updated = await (await request(`/api/v1/mailboxes/${mailbox}`)).json() as { settings: unknown };
				assert.deepEqual(updated.settings, settings, "Later delivery preserves customized settings");
			}
			await deliver("outside@example.com", "Other domain", `To: ${mailboxes[0]}\r\n`);
			assert.equal((await request("/api/v1/mailboxes/outside@example.com")).status, 404);

			// Each SMTP delivery gets its own mailbox, even with identical To headers.
			const headers = `To: ${mailboxes.join(", ")}\r\n`;
			await deliver("HELLO@LISENSE.UK", "Both domains", headers);
			await deliver("HELLO@SNAILBOX.LIVE", "Both domains", headers);
			assert.equal((await inbox(mailboxes[0])).emails.length, 1);
			assert.equal((await inbox(mailboxes[1])).emails.length, 1);

			await deliver(mailboxes[1], "CC delivery", `To: other@example.com\r\nCc: ${mailboxes[1]}\r\n`);
			await deliver(mailboxes[1], "BCC delivery", "");
			const snailbox = await inbox(mailboxes[1]);
			assert.deepEqual(snailbox.emails.map((email) => email.subject).sort(), ["BCC delivery", "Both domains", "CC delivery"]);
			assert.equal((await inbox(mailboxes[0])).emails.length, 1);

			// Unlisted addresses create their own mailbox only without an allowlist.
			await deliver("blocked@snailbox.live", "Unapproved delivery", headers);
			assert.equal((await inbox(mailboxes[0])).emails.length, 1);
			assert.equal((await inbox(mailboxes[1])).emails.length, 3);
			assert.equal((await request("/api/v1/mailboxes/blocked@snailbox.live")).status, restricted ? 404 : 200);
			if (!restricted) assert.equal((await inbox("blocked@snailbox.live")).emails[0].subject, "Unapproved delivery");

			const bucket = await mf.getR2Bucket("BUCKET");
			for (const mailbox of mailboxes) {
				const original = (await inbox(mailbox)).emails[0];
				const path = `/api/v1/mailboxes/${mailbox}/emails/${original.id}/forward`;
				const body = { to: "recipient@example.com", from: mailbox, subject: "Forward", text: "Hello" };
				const sent = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
				assert.equal(sent.status, 202);
				const { id } = await sent.json() as { id: string };
				const provider = await (await bucket.get("test-last-send.json"))!.json<{ from: string }>();
				assert.equal(provider.from, mailbox);
				const stored = await (await request(`/api/v1/mailboxes/${mailbox}/emails/${id}`)).json() as { sender: string; message_id: string };
				assert.equal(stored.sender, mailbox);
				assert.ok(stored.message_id.endsWith(`@${mailbox.split("@")[1]}`));
				const otherMailbox = mailboxes.find((other) => other !== mailbox)!;
				assert.equal((await request(`/api/v1/mailboxes/${otherMailbox}/emails/${id}`)).status, 404);
				const mismatch = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, from: otherMailbox }) });
				assert.equal(mismatch.status, 400);
			}
		} finally {
			await mf.dispose();
		}
	}
});
