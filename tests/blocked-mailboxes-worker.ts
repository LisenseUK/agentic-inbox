import { MailboxDO } from "../workers/durableObject";
import worker from "./mcp-events-worker";
import type { Env } from "../workers/types";
export { TestEmailAgent } from "./mcp-events-worker";

export class TestMailboxDO extends MailboxDO {
	// Tests drive delivery explicitly so blocking a queued event is deterministic.
	async alarm() {}
	async deliverEvents() { await super.alarm(); }
	async eventCounts() {
		return {
			subscriptions: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_event_subscriptions").one().count,
			deliveries: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_event_deliveries").one().count,
		};
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/event-state" || url.pathname === "/deliver-events") {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(url.searchParams.get("mailbox")!)) as unknown as DurableObjectStub<TestMailboxDO>;
			if (url.pathname === "/deliver-events") await stub.deliverEvents();
			return Response.json(await stub.eventCounts());
		}
		return worker.fetch(request, env, ctx);
	},
};
