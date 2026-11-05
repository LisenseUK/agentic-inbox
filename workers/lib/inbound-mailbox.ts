import type { Env } from "../types";
import { provisionMailbox, MailboxError } from "./mailbox-management";
import { isMailboxBlocked } from "./mailbox-access";

/** Resolve the delivery address and create its mailbox before storing the mail. */
export async function resolveInboundMailbox(env: Env, recipient: string): Promise<string | null> {
	const email = recipient.toLowerCase().trim();
	const domain = email.slice(email.lastIndexOf("@") + 1);
	const domains = env.DOMAINS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
	if (!email.includes("@") || !domains.includes(domain)) return null;
	const allowed = (env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowed.length && !allowed.some((address) => address.toLowerCase() === email)) return null;
	if (await isMailboxBlocked(env.BUCKET, email)) return null;
	if (await env.BUCKET.head(`mailboxes/${email}.json`)) return email;

	const catchAll = (env.CATCH_ALL_MAILBOX || "").toLowerCase().trim();
	const mailboxId = catchAll || email;
	if (await isMailboxBlocked(env.BUCKET, mailboxId)) return null;
	try {
		await provisionMailbox(env, { email: mailboxId, name: catchAll ? "Catch-All" : email.slice(0, email.lastIndexOf("@")) });
	} catch (error) {
		// Another delivery or the UI may have created it while we were waiting.
		if (error instanceof MailboxError && error.status === 404) return null;
		if (!(error instanceof MailboxError) || error.status !== 409) throw error;
	}
	return mailboxId;
}
