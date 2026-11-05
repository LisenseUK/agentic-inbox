// Test-only Worker exercising the real mailbox RPC and inbound mail path.
import { DurableObject } from "cloudflare:workers";
import { app, receiveEmail } from "../workers/index";
import { handleModernMcp } from "../workers/mcp/modern";
import type { Env } from "../workers/types";
export { MailboxDO } from "../workers/durableObject";
export class TestEmailAgent extends DurableObject {
	async suspendMailbox() {}
	async fetch(request: Request) {
		if (request.method === "GET") return Response.json({ count: await this.ctx.storage.get<number>("count") ?? 0 });
		await this.ctx.storage.put("count", (await this.ctx.storage.get<number>("count") ?? 0) + 1);
		return new Response("ok");
	}
}
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const path = new URL(request.url).pathname;
		// Test-only sender records bytes and never contacts an email provider.
		env = { ...env, EMAIL: { async send(message: unknown) {
			const payload = message as { to: string; attachments?: { content: Uint8Array }[] };
			if (payload.to === "fail@example.com") throw new Error("Simulated provider failure");
			await env.BUCKET.put("test-last-send.json", JSON.stringify({ ...payload,
				attachments: payload.attachments?.map((item) => ({ ...item, bytes: Array.from(item.content), content: undefined })),
			}));
			return { messageId: "test-delivery" };
		} } };
		if (path === "/seed-features") {
			await env.BUCKET.put("mailboxes/features@lisense.uk.json", "{\"autoReplyDrafting\":false}");
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName("features@lisense.uk"));
			await stub.getFolders();
			const attachment = { id: "file-1", email_id: "email-1", filename: "invoice.txt", mimetype: "text/plain", size: 7, content_id: null, disposition: "attachment" };
			await env.BUCKET.put("attachments/email-1/file-1/invoice.txt", new Uint8Array([0, 1, 2, 65, 66, 67, 255]));
			await stub.createEmail("inbox", { id: "email-1", subject: "Invoice Alpha", sender: "accounts@example.com", recipient: "features@lisense.uk",
				cc: "finance@example.com", date: "2026-10-10T10:00:00.000Z", body: "<p>Invoice attached</p>", thread_id: "thread-1" }, [attachment]);
			await stub.createEmail("inbox", { id: "email-2", subject: "Invoice Beta", sender: "accounts@example.com", recipient: "features@lisense.uk",
				date: "2026-10-11T10:00:00.000Z", body: "Second invoice", thread_id: "thread-1" }, []);
			await stub.createEmail("inbox", { id: "email-3", subject: "Other", sender: "other@example.com", recipient: "features@lisense.uk",
				date: "2026-09-01T10:00:00.000Z", body: "Other message", thread_id: "thread-3" }, []);
			return new Response("ok");
		}
		if (path.startsWith("/api/")) return app.fetch(request, env, ctx);
		if (path === "/agent-count") {
			const id = new URL(request.url).searchParams.get("mailboxId")!;
			return env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(id)).fetch(new Request("https://agents/count"));
		}
		if (path === "/seed") {
			await env.BUCKET.put("mailboxes/hello@lisense.uk.json", "{}");
			await env.MAILBOX.get(env.MAILBOX.idFromName("hello@lisense.uk")).getFolders();
			return new Response("ok");
		}
		if (path === "/receive") {
			const bytes = await request.arrayBuffer();
			await receiveEmail({ to: request.headers.get("X-Envelope-To") || "", raw: new Response(bytes).body!, rawSize: bytes.byteLength }, env, ctx);
			return new Response("ok");
		}
		return handleModernMcp(request, env, { id: "user-1", assertion: "test-assertion", expiresAt: Date.now() + 3_600_000 });
	},
};
