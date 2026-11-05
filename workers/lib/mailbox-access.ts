import type { Env } from "../types";

export class MailboxError extends Error {
	constructor(message: string, public status: 403 | 404 | 409) { super(message); }
}

export function blockedMailboxKey(mailboxId: string) {
	return `blocked-mailboxes/${mailboxId.toLowerCase().trim()}.json`;
}

export async function isMailboxBlocked(bucket: R2Bucket, mailboxId: string) {
	return !!await bucket.head(blockedMailboxKey(mailboxId));
}

export async function isMailboxActive(env: Env, mailboxId: string) {
	const id = mailboxId.toLowerCase().trim();
	const [blocked, mailbox] = await Promise.all([
		isMailboxBlocked(env.BUCKET, id), env.BUCKET.head(`mailboxes/${id}.json`),
	]);
	return !blocked && !!mailbox;
}

export async function listMailboxObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}
