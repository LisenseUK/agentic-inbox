// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";
import { isMailboxActive } from "./mailbox-access";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}

/** Encode stored binary content for MCP resources and the app's attachment payloads. */
export function attachmentBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}

export async function readEmailAttachment(env: Env, mailboxId: string, emailId: string, attachmentId: string, maxBytes = 5 * 1024 * 1024) {
	if (!await isMailboxActive(env, mailboxId)) return { error: "Mailbox not found" };
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const email = await stub.getEmail(emailId);
	if (!email) return { error: "Email not found" };
	const attachment = email.attachments.find((item) => item.id === attachmentId);
	if (!attachment) return { error: "Attachment not found on this email" };
	const obj = await env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return { error: "Attachment file not found" };
	if (obj.size > maxBytes) {
		await obj.body.cancel();
		return { error: `Attachment exceeds the ${maxBytes} byte limit. Download it through the app instead.` };
	}
	const bytes = new Uint8Array(await obj.arrayBuffer());
	return { attachment, bytes };
}
