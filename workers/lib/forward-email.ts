// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sendMailboxEmail, type SendEmailParams } from "../email-sender";
import { storeAttachments, readEmailAttachment, attachmentBase64 } from "./attachments";
import { getMailboxStub, validateSender, generateMessageId, resolveOriginalEmail, getFullEmail, textToHtml, stripHtmlToText } from "./email-helpers";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

export class ForwardEmailError extends Error {
	constructor(message: string, public status: 400 | 404 | 429 | 502) { super(message); }
}

/** Forwarding starts a new conversation and records Sent only after delivery succeeds. */
export async function forwardEmail(env: Env, mailboxId: string, emailId: string, body: SendEmailParams) {
	const stub = await getMailboxStub(env, mailboxId);
	const original = await stub.getEmail(emailId);
	if (!original) throw new ForwardEmailError("Original email not found", 404);
	const { toStr, fromEmail, fromDomain } = validateSender(body.to, body.from, mailboxId);
	const rateLimitError = await stub.checkSendRateLimit();
	if (rateLimitError) throw new ForwardEmailError(rateLimitError, 429);
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	try { await sendMailboxEmail(env, body); }
	catch (error) { throw new ForwardEmailError(`Failed to forward email: ${(error as Error).message}`, 502); }
	const attachments = await storeAttachments(env.BUCKET, messageId, body.attachments);
	const now = new Date().toISOString();
	await stub.createEmail(Folders.SENT, {
		id: messageId, subject: body.subject, sender: fromEmail, recipient: toStr,
		cc: body.cc ? (Array.isArray(body.cc) ? body.cc.join(", ") : body.cc).toLowerCase() : null,
		bcc: body.bcc ? (Array.isArray(body.bcc) ? body.bcc.join(", ") : body.bcc).toLowerCase() : null,
		date: now, body: body.html || body.text || "", in_reply_to: null, email_references: null,
		thread_id: messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof body.from === "string" ? body.from : `${body.from.name} <${body.from.email}>` },
			{ key: "to", value: toStr }, { key: "subject", value: body.subject },
			{ key: "date", value: now }, { key: "message-id", value: `<${outgoingMessageId}>` },
			...(body.cc ? [{ key: "cc", value: Array.isArray(body.cc) ? body.cc.join(", ") : body.cc }] : []),
			...(body.bcc ? [{ key: "bcc", value: Array.isArray(body.bcc) ? body.bcc.join(", ") : body.bcc }] : []),
		]),
	}, attachments);
	return { id: messageId, status: "sent" };
}

export async function toolForwardEmail(env: Env, mailboxId: string, emailId: string, params: {
	to: string; bodyHtml?: string; includeAttachments: boolean;
}) {
	const stub = await getMailboxStub(env, mailboxId);
	const rawOriginal = await getFullEmail(stub, emailId);
	if (!rawOriginal) return { error: "Original email not found" };
	const original = await resolveOriginalEmail(stub, rawOriginal);
	const originalBody = original.body || "";
	const quotedBody = /<\/?[a-z][^>]*>/i.test(originalBody) ? originalBody : textToHtml(originalBody);
	const html = `${params.bodyHtml || ""}<hr><p>Forwarded message</p>${textToHtml(`From: ${original.sender}\nTo: ${original.recipient}\nDate: ${original.date}\nSubject: ${original.subject}`)}${quotedBody}`;
	const attachments: NonNullable<SendEmailParams["attachments"]> = [];
	let remaining = 25 * 1024 * 1024;
	if (params.includeAttachments) {
		for (const attachment of original.attachments || []) {
			const loaded = await readEmailAttachment(env, mailboxId, original.id, attachment.id, remaining);
			if ("error" in loaded) return loaded;
			remaining -= loaded.bytes.byteLength;
			attachments.push({ content: attachmentBase64(loaded.bytes), filename: attachment.filename,
				type: attachment.mimetype, disposition: attachment.disposition === "inline" ? "inline" : "attachment",
				...(attachment.content_id ? { contentId: attachment.content_id } : {}),
			});
		}
	}
	try {
		return await forwardEmail(env, mailboxId, original.id, {
			to: params.to, from: mailboxId, subject: /^fwd:/i.test(original.subject || "") ? original.subject : `Fwd: ${original.subject || ""}`,
			html, text: stripHtmlToText(html), attachments,
		});
	} catch (error) {
		if (error instanceof ForwardEmailError) return { error: error.message };
		throw error;
	}
}
