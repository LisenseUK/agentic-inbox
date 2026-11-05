// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import type { Env } from "../types";
import { blockedMailboxKey, isMailboxActive, isMailboxBlocked, listMailboxObjects, MailboxError } from "./mailbox-access";
export { MailboxError } from "./mailbox-access";

export const MailboxSettingsSchema = z.object({
	autoReplyDrafting: z.boolean().optional(),
}).passthrough();

export const CreateMailboxSchema = z.object({
	email: z.string().email().transform((email) => email.toLowerCase()),
	name: z.string().min(1),
	settings: MailboxSettingsSchema.optional(),
});

export async function createMailbox(env: Env, input: z.input<typeof CreateMailboxSchema>) {
	const { email, name, settings } = CreateMailboxSchema.parse(input);
	const allowed = (env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowed.length && !allowed.some((address) => address.toLowerCase() === email)) {
		throw new MailboxError("Mailbox creation is restricted to configured EMAIL_ADDRESSES", 403);
	}
	return provisionMailbox(env, { email, name, settings });
}

/** Store a mailbox after its caller has checked the applicable address policy. */
export async function provisionMailbox(env: Env, input: z.input<typeof CreateMailboxSchema>) {
	const { email, name, settings } = CreateMailboxSchema.parse(input);
	if (await isMailboxBlocked(env.BUCKET, email)) throw new MailboxError("Mailbox not found", 404);
	const key = `mailboxes/${email}.json`;
	if (await env.BUCKET.head(key)) throw new MailboxError("Mailbox already exists", 409);
	const finalSettings = {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		autoReplyDrafting: true,
		...settings,
	};
	await env.MAILBOX.get(env.MAILBOX.idFromName(email)).getFolders();
	const created = await env.BUCKET.put(key, JSON.stringify(finalSettings), {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	if (!created) throw new MailboxError("Mailbox already exists", 409);
	return { id: email, email, name, settings: finalSettings };
}

export async function deleteMailbox(env: Env, mailboxId: string) {
	const id = mailboxId.toLowerCase();
	const key = `mailboxes/${id}.json`;
	if (!(await isMailboxActive(env, id))) throw new MailboxError("Mailbox not found", 404);
	// Match HTTP removal behavior: stored messages and attachments are retained.
	await env.BUCKET.delete(key);
	return { status: "deleted", mailboxId: id };
}

export async function isReplyDraftingEnabled(env: Env, mailboxId: string) {
	if (await isMailboxBlocked(env.BUCKET, mailboxId)) return false;
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return false;
	const settings = await obj.json<Record<string, unknown>>();
	return settings.autoReplyDrafting !== false;
}

export async function listBlockedMailboxes(env: Env) {
	return (await listMailboxObjects(env.BUCKET, "blocked-mailboxes/")).map((object) => {
		const email = object.key.slice("blocked-mailboxes/".length, -".json".length);
		return { id: email, email, blockedAt: object.uploaded.toISOString() };
	});
}

async function clearMailboxEvents(env: Env, email: string) {
	if (await env.BUCKET.head(`mailboxes/${email}.json`)) {
		await env.MAILBOX.get(env.MAILBOX.idFromName(email)).clearMcpEvents();
	}
}

export async function blockMailbox(env: Env, address: string) {
	const email = z.string().email().parse(address).toLowerCase();
	await env.BUCKET.put(blockedMailboxKey(email), "{}", { onlyIf: { etagDoesNotMatch: "*" } });
	// The marker takes effect even if an unavailable mailbox cannot clear its queue.
	try { await clearMailboxEvents(env, email); }
	catch (error) { console.error("Could not clear blocked mailbox events:", error); }
	if (await env.BUCKET.head(`mailboxes/${email}.json`)) {
		try { await env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(email)).suspendMailbox(); }
		catch (error) { console.error("Could not close blocked mailbox connections:", error); }
	}
	return { id: email, status: "blocked" };
}

export async function unblockMailbox(env: Env, address: string) {
	const email = z.string().email().parse(address).toLowerCase();
	if (await isMailboxBlocked(env.BUCKET, email)) {
		// Clear again before restoring access so old notifications cannot resume.
		await clearMailboxEvents(env, email);
		await env.BUCKET.delete(blockedMailboxKey(email));
	}
	return { id: email, status: "unblocked" };
}
