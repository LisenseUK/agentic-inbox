// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	callbackUrl, equalChallenge, EventError, matchesEvent, signWebhook, signingKey, subscriptionId, verificationCacheKey,
	type EmailReceivedEvent, type EventPrincipal, type EventSubscriptionRequest, type EventUnsubscribeRequest,
} from "./events-protocol";

type SqlRow = Record<string, string | number | null>;
export interface EventStorage {
	sql: { exec<T extends SqlRow = SqlRow>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] } };
	transactionSync<T>(callback: () => T): T;
	setAlarm(time: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}
interface StoredSubscription {
	id: string;
	request: EventSubscriptionRequest;
	principal: EventPrincipal;
	expiresAt: number;
	previousSecret?: string;
	rotationUntil?: number;
}
interface SubscriptionRow extends SqlRow { id: string; configuration: string; revision: string; expires_at: number }
interface DeliveryRow extends SqlRow { subscription_id: string; event_id: string; body: string; attempts: number; due_at: number }
export interface EventDependencies {
	fetch: typeof fetch;
	authorized: (principal: EventPrincipal, mailboxId: string) => Promise<boolean>;
}
const MAX_ATTEMPTS = 8;
const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const VERIFY_CACHE_MS = 5 * 60 * 1000;

async function readSmallJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Missing callback response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2048) throw new Error("Callback response too large");
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder().decode(bytes));
}

/** Persistent subscription and delivery outbox, sharded with the mailbox. */
export class MailboxEvents {
	constructor(private storage: EventStorage, private hosts: string, private dependencies: EventDependencies) {
		storage.transactionSync(() => storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
				id TEXT PRIMARY KEY, configuration TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS mcp_event_pending (id TEXT PRIMARY KEY, revision TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS mcp_event_verifications (
				cache_key TEXT PRIMARY KEY, verified_until INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS mcp_event_deliveries (
				subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
				PRIMARY KEY (subscription_id, event_id)
			);
			CREATE INDEX IF NOT EXISTS mcp_event_due ON mcp_event_deliveries(due_at);
		`));
	}

	async subscribe(principal: EventPrincipal, request: EventSubscriptionRequest) {
		if (principal.expiresAt <= Date.now()) throw new EventError(-32012, "Authentication expired");
		if (request.cursor != null) throw new EventError(-32014, "Email events do not support replay", { feature: "cursor" });
		try { callbackUrl(request.delivery.url, this.hosts); signingKey(request.delivery.secret); }
		catch { throw new EventError(-32602, "Invalid callback URL or signing secret"); }
		if (!await this.dependencies.authorized(principal, request.arguments.mailboxId)) throw new EventError(-32012, "Mailbox access denied");
		const id = await subscriptionId(principal.id, request);
		const revision = crypto.randomUUID();
		const count = this.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM mcp_event_subscriptions WHERE expires_at > ?", Date.now()).toArray()[0].count;
		if (count >= 100 && !this.get(id)) throw new EventError(-32014, "Mailbox subscription limit reached");
		this.storage.sql.exec("INSERT OR REPLACE INTO mcp_event_pending (id, revision) VALUES (?, ?)", id, revision);
		// Includes the key, so a replacement secret is verified even when the URL
		// and owner were verified recently. No raw credential is used as a DB key.
		const cacheKey = await verificationCacheKey(principal.id, request.delivery.url, request.delivery.secret);
		try {
			const cached = this.storage.sql.exec<{ verified_until: number }>("SELECT verified_until FROM mcp_event_verifications WHERE cache_key = ?", cacheKey).toArray()[0];
			if (!cached || cached.verified_until <= Date.now()) {
				const challenge = crypto.randomUUID();
				const response = await this.post(id, request.delivery.url, request.delivery.secret, `msg_verification_${crypto.randomUUID()}`, JSON.stringify({ type: "verification", challenge }));
				if (!response.ok) { await response.body?.cancel(); throw new EventError(-32015, "Callback verification failed", { reason: "challenge_failed" }); }
				const result = await readSmallJson(response);
				const echoed = result && typeof result === "object" && "challenge" in result ? result.challenge : undefined;
				if (!await equalChallenge(challenge, echoed)) throw new EventError(-32015, "Callback verification failed", { reason: "challenge_failed" });
				this.storage.sql.exec("INSERT OR REPLACE INTO mcp_event_verifications VALUES (?, ?)", cacheKey, Date.now() + VERIFY_CACHE_MS);
			}
		} catch (error) {
			this.storage.sql.exec("DELETE FROM mcp_event_pending WHERE id = ? AND revision = ?", id, revision);
			if (error instanceof EventError) throw error;
			const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			throw new EventError(-32015, "Callback verification failed", { reason: timeout ? "timeout" : "challenge_failed" });
		}
		const pending = this.storage.sql.exec<{ revision: string }>("SELECT revision FROM mcp_event_pending WHERE id = ?", id).toArray()[0];
		if (pending?.revision !== revision) throw new EventError(-32015, "Subscription was replaced or cancelled", { reason: "challenge_failed" });
		const expiresAt = Math.min(Date.now() + Math.min(request.ttlMs ?? DEFAULT_TTL, DEFAULT_TTL), principal.expiresAt);
		if (expiresAt <= Date.now()) {
			this.storage.sql.exec("DELETE FROM mcp_event_pending WHERE id = ? AND revision = ?", id, revision);
			throw new EventError(-32012, "Authentication expired");
		}
		const currentRow = this.get(id);
		const current: StoredSubscription | undefined = currentRow && JSON.parse(currentRow.configuration);
		const rotating = current && current.request.delivery.secret !== request.delivery.secret;
		const stored: StoredSubscription = {
			id, request, principal, expiresAt,
			previousSecret: rotating ? current.request.delivery.secret : current?.previousSecret,
			rotationUntil: rotating ? Date.now() + VERIFY_CACHE_MS : current?.rotationUntil,
		};
		// Arm before the atomic write: a crash can cause a harmless early wakeup,
		// but cannot leave a committed subscription without expiration cleanup.
		await this.storage.setAlarm(Date.now() + 1000);
		this.storage.transactionSync(() => {
			// Network I/O above may have allowed an unsubscribe or another refresh.
			const latest = this.storage.sql.exec<{ revision: string }>("SELECT revision FROM mcp_event_pending WHERE id = ?", id).toArray()[0];
			if (latest?.revision !== revision) throw new EventError(-32015, "Subscription was replaced or cancelled", { reason: "challenge_failed" });
			const active = this.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM mcp_event_subscriptions WHERE expires_at > ?", Date.now()).toArray()[0].count;
			if (active >= 100 && !this.get(id)) throw new EventError(-32014, "Mailbox subscription limit reached");
			this.storage.sql.exec("INSERT OR REPLACE INTO mcp_event_subscriptions VALUES (?, ?, ?, ?)", id, JSON.stringify(stored), revision, expiresAt);
			this.storage.sql.exec("DELETE FROM mcp_event_pending WHERE id = ?", id);
		});
		return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
	}

	async unsubscribe(principal: EventPrincipal, request: EventUnsubscribeRequest) {
		const id = await subscriptionId(principal.id, request);
		this.remove(id);
		return {};
	}

	/** Call inside the transaction that saves the incoming email. */
	enqueue(event: EmailReceivedEvent, fullSubject = event.data.subject): void {
		const body = JSON.stringify(event);
		if (new TextEncoder().encode(body).byteLength > 256 * 1024) throw new Error("MCP event exceeds payload limit");
		const rows = this.storage.sql.exec<SubscriptionRow>("SELECT * FROM mcp_event_subscriptions WHERE expires_at > ?", Date.now()).toArray();
		for (const row of rows) {
			const subscription: StoredSubscription = JSON.parse(row.configuration);
			if (matchesEvent(subscription.request.arguments, { ...event.data, subject: fullSubject })) {
				this.storage.sql.exec("INSERT OR IGNORE INTO mcp_event_deliveries (subscription_id, event_id, body, due_at) VALUES (?, ?, ?, ?)", row.id, event.eventId, body, Date.now());
			}
		}
	}

	async arm(): Promise<void> { await this.storage.setAlarm(Date.now() + 1000); }

	async clear(): Promise<void> {
		this.storage.transactionSync(() => {
			for (const table of ["mcp_event_subscriptions", "mcp_event_pending", "mcp_event_verifications", "mcp_event_deliveries"]) {
				this.storage.sql.exec(`DELETE FROM ${table}`);
			}
		});
		await this.storage.deleteAlarm();
	}

	async alarm(): Promise<void> {
		this.storage.sql.exec("DELETE FROM mcp_event_subscriptions WHERE expires_at <= ?", Date.now());
		this.storage.sql.exec("DELETE FROM mcp_event_verifications WHERE verified_until <= ?", Date.now());
		this.storage.sql.exec("DELETE FROM mcp_event_deliveries WHERE subscription_id NOT IN (SELECT id FROM mcp_event_subscriptions)");
		const jobs = this.storage.sql.exec<DeliveryRow>("SELECT * FROM mcp_event_deliveries WHERE due_at <= ? ORDER BY due_at LIMIT 5", Date.now()).toArray();
		for (const job of jobs) await this.deliver(job);
		const nextDelivery = this.storage.sql.exec<{ next: number | null }>("SELECT min(due_at) AS next FROM mcp_event_deliveries").toArray()[0].next;
		const nextExpiry = this.storage.sql.exec<{ next: number | null }>("SELECT min(expires_at) AS next FROM mcp_event_subscriptions").toArray()[0].next;
		const next = Math.min(nextDelivery ?? Infinity, nextExpiry ?? Infinity);
		if (Number.isFinite(next)) await this.storage.setAlarm(Math.max(Date.now() + 100, next));
		else await this.storage.deleteAlarm();
	}

	private get(id: string) { return this.storage.sql.exec<SubscriptionRow>("SELECT * FROM mcp_event_subscriptions WHERE id = ?", id).toArray()[0]; }
	private remove(id: string, revision?: string): void {
		this.storage.transactionSync(() => {
			if (revision && this.get(id)?.revision !== revision) return;
			this.storage.sql.exec("DELETE FROM mcp_event_subscriptions WHERE id = ?", id);
			this.storage.sql.exec("DELETE FROM mcp_event_pending WHERE id = ?", id);
			this.storage.sql.exec("DELETE FROM mcp_event_deliveries WHERE subscription_id = ?", id);
		});
	}

	private async deliver(job: DeliveryRow): Promise<void> {
		const row = this.get(job.subscription_id);
		if (!row) return;
		const subscription: StoredSubscription = JSON.parse(row.configuration);
		let terminal = false;
		try {
			if (!await this.dependencies.authorized(subscription.principal, subscription.request.arguments.mailboxId)) {
				this.remove(row.id, row.revision); return;
			}
			const latest = this.get(row.id);
			if (!latest || latest.revision !== row.revision || latest.expires_at <= Date.now()) return;
			const previous = subscription.rotationUntil && subscription.rotationUntil > Date.now() ? subscription.previousSecret : undefined;
			const response = await this.post(row.id, subscription.request.delivery.url, subscription.request.delivery.secret, job.event_id, job.body, previous);
			await response.body?.cancel();
			if (response.status === 410) { this.remove(row.id, row.revision); return; }
			terminal = response.ok || (response.status !== 408 && response.status !== 429 && response.status < 500);
			if (!response.ok) console.warn("MCP event delivery rejected", { subscriptionId: row.id, status: response.status });
		} catch { console.warn("MCP event delivery temporarily failed", { subscriptionId: row.id }); }
		if (terminal || job.attempts + 1 >= MAX_ATTEMPTS) {
			this.storage.sql.exec("DELETE FROM mcp_event_deliveries WHERE subscription_id = ? AND event_id = ?", job.subscription_id, job.event_id);
		} else {
			const delay = Math.min(60_000, 1000 * 2 ** job.attempts);
			this.storage.sql.exec("UPDATE mcp_event_deliveries SET attempts = attempts + 1, due_at = ? WHERE subscription_id = ? AND event_id = ?", Date.now() + delay, job.subscription_id, job.event_id);
		}
	}

	private async post(id: string, rawUrl: string, secret: string, webhookId: string, body: string, previous?: string): Promise<Response> {
		const url = callbackUrl(rawUrl, this.hosts);
		const timestamp = Math.floor(Date.now() / 1000);
		const signatures = [await signWebhook(secret, webhookId, timestamp, body)];
		if (previous) signatures.push(await signWebhook(previous, webhookId, timestamp, body));
		return this.dependencies.fetch(url, {
			method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
			headers: { "Content-Type": "application/json", "User-Agent": "agentic-inbox-mcp-events/1.0", "webhook-id": webhookId,
				"webhook-timestamp": String(timestamp), "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": id },
			body,
		});
	}
}
