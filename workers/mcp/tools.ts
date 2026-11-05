// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import { createMailbox, deleteMailbox, MailboxError } from "../lib/mailbox-management";
import { toolSearchEmailPage, toolListFolders, toolCreateFolder, toolMarkThreadRead, toolStarEmail } from "../lib/mcp-actions";
import { readEmailAttachment, attachmentBase64 } from "../lib/attachments";
import { toolForwardEmail } from "../lib/forward-email";
import type { Env } from "../types";
import { isMailboxActive } from "../lib/mailbox-access";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

export type RegisterEmailTool = <Shape extends z.ZodRawShape>(
	name: string, description: string, shape: Shape,
	handler: (args: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult>,
) => void;

export function registerEmailTools(register: RegisterEmailTool, env: Env) {

	/**
	 * Verify a mailbox exists in R2 before operating on it.
	 * Returns an MCP error response if the mailbox is not found, or null if valid.
	 */
	const verifyMailbox = async (mailboxId: string) => {
		if (!await isMailboxActive(env, mailboxId)) {
			return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
		}
		return null;
	};

	// ── list_mailboxes ─────────────────────────────────────────
	register(
		"list_mailboxes",
		"List all available mailboxes",
		{},
		async () => {
			const result = await toolListMailboxes(env);
			return mcpText(result);
		},
	);

	const mailboxOperation = async (operation: () => Promise<Record<string, unknown>>) => {
		try { return mcpText(await operation()); }
		catch (error) {
			if (error instanceof MailboxError) return mcpError(error.message);
			throw error;
		}
	};
	register("create_mailbox", "Create an inbox for an email address. Respects configured EMAIL_ADDRESSES restrictions.", {
		email: z.string().email().describe("Email address for the new inbox"),
		name: z.string().min(1).describe("Display name for outgoing email"),
	}, async ({ email, name }) => mailboxOperation(() => createMailbox(env, { email, name })));
	register("delete_mailbox", "Remove an inbox from the app. Stored messages and attachments are retained and will reappear if the inbox is recreated.", {
		mailboxId: z.string().email().describe("Email address of the inbox to remove"),
	}, async ({ mailboxId }) => mailboxOperation(() => deleteMailbox(env, mailboxId)));

	// ── list_emails ────────────────────────────────────────────
	register(
		"list_emails",
		"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
		{
			mailboxId: z
				.string()
				.describe("The mailbox email address (e.g. user@example.com)"),
			folder: z
				.string()
				.default(Folders.INBOX)
				.describe(FOLDER_TOOL_DESCRIPTION),
			limit: z
				.number()
				.default(20)
				.describe("Maximum number of emails to return"),
			page: z
				.number()
				.default(1)
				.describe("Page number for pagination"),
		},
		async ({ mailboxId, folder, limit, page }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolListEmails(env, mailboxId, { folder, limit, page });
			return mcpText(result);
		},
	);

	// ── get_email ──────────────────────────────────────────────
	register(
		"get_email",
		"Get a single email with its full body content. Use this to read the actual content of an email.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			emailId: z.string().describe("The email ID to retrieve"),
		},
		async ({ mailboxId, emailId }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolGetEmail(env, mailboxId, emailId);
			if ("error" in result) {
				return {
					content: [{ type: "text" as const, text: "Email not found" }],
					isError: true,
				};
			}
			return mcpText(result);
		},
	);

	// ── get_thread ─────────────────────────────────────────────
	register(
		"get_thread",
		"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			threadId: z
				.string()
				.describe("The thread_id to retrieve all messages for"),
		},
		async ({ mailboxId, threadId }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolGetThread(env, mailboxId, threadId);
			return mcpText(result);
		},
	);

	// ── search_emails ──────────────────────────────────────────
	register("search_emails", "Search emails using text and optional filters. Returns emails, totalCount, page and limit.", {
		mailboxId: z.string().describe("The mailbox email address"),
		query: z.string().default("").describe("Text to match across subject, body and addresses; omit to use filters only"),
		folder: z.string().optional().describe("Folder ID or name"),
		from: z.string().optional().describe("Sender address or substring"),
		to: z.string().optional().describe("Recipient address or substring, including CC and BCC"),
		subject: z.string().optional().describe("Subject substring"),
		date_start: z.string().datetime({ offset: true }).transform((date) => new Date(date).toISOString()).optional().describe("Inclusive start timestamp in ISO 8601 format"),
		date_end: z.string().datetime({ offset: true }).transform((date) => new Date(date).toISOString()).optional().describe("Inclusive end timestamp in ISO 8601 format"),
		is_read: z.boolean().optional().describe("Filter read or unread emails"),
		is_starred: z.boolean().optional().describe("Filter starred or unstarred emails"),
		has_attachment: z.boolean().optional().describe("Filter emails with or without attachments"),
		page: z.number().int().min(1).default(1),
		limit: z.number().int().min(1).max(100).default(25),
	}, async ({ mailboxId, ...params }) => {
		const denied = await verifyMailbox(mailboxId);
		if (denied) return denied;
		if (params.date_start && params.date_end && Date.parse(params.date_start) > Date.parse(params.date_end)) {
			return mcpError("date_start must be before or equal to date_end");
		}
		return mcpText(await toolSearchEmailPage(env, mailboxId, params));
	});

	register("get_attachment", "Download an email attachment as an embedded MCP resource. Maximum file size is 5 MiB. Get attachment IDs from get_email.", {
		mailboxId: z.string().describe("The mailbox email address"),
		emailId: z.string().describe("The email containing the attachment"),
		attachmentId: z.string().describe("The attachment ID from get_email"),
	}, async ({ mailboxId, emailId, attachmentId }) => {
		const denied = await verifyMailbox(mailboxId);
		if (denied) return denied;
		const loaded = await readEmailAttachment(env, mailboxId, emailId, attachmentId);
		if ("error" in loaded) return mcpError(loaded.error!);
		return { content: [
			{ type: "text", text: JSON.stringify({ filename: loaded.attachment.filename, mimeType: loaded.attachment.mimetype, size: loaded.bytes.byteLength }) },
			{ type: "resource", resource: {
				uri: `mail-attachment://${encodeURIComponent(mailboxId)}/${encodeURIComponent(emailId)}/${encodeURIComponent(attachmentId)}`,
				mimeType: loaded.attachment.mimetype, blob: attachmentBase64(loaded.bytes),
			} },
		] };
	});

	register("list_folders", "List folders with their IDs, display names and unread counts. Use IDs with move_email.", {
		mailboxId: z.string().describe("The mailbox email address"),
	}, async ({ mailboxId }) => {
		const denied = await verifyMailbox(mailboxId);
		return denied || mcpText(await toolListFolders(env, mailboxId));
	});
	register("create_folder", "Create a custom folder and return its ID for move_email.", {
		mailboxId: z.string().describe("The mailbox email address"),
		name: z.string().trim().min(1).max(200).describe("Folder display name"),
	}, async ({ mailboxId, name }) => {
		const denied = await verifyMailbox(mailboxId);
		return denied || mcpResult(await toolCreateFolder(env, mailboxId, name));
	});
	register("mark_thread_read", "Mark all messages in a conversation as read.", {
		mailboxId: z.string().describe("The mailbox email address"),
		threadId: z.string().min(1).describe("Thread ID from get_email or list_emails"),
	}, async ({ mailboxId, threadId }) => {
		const denied = await verifyMailbox(mailboxId);
		return denied || mcpResult(await toolMarkThreadRead(env, mailboxId, threadId));
	});
	register("star_email", "Star or unstar an email for follow-up.", {
		mailboxId: z.string().describe("The mailbox email address"),
		emailId: z.string().min(1).describe("The email ID"),
		starred: z.boolean().describe("true to star, false to unstar"),
	}, async ({ mailboxId, emailId, starred }) => {
		const denied = await verifyMailbox(mailboxId);
		return denied || mcpResult(await toolStarEmail(env, mailboxId, emailId, starred));
	});
	register("forward_email", "Send an existing email to another recipient as a new conversation. Includes original content and attachments by default. Only call after getting confirmation.", {
		mailboxId: z.string().describe("The mailbox email address to send from"),
		emailId: z.string().min(1).describe("The email ID to forward"),
		to: z.string().email().describe("Forward recipient"),
		bodyHtml: z.string().optional().describe("Optional HTML note before the forwarded message"),
		includeAttachments: z.boolean().default(true).describe("Include original attachments; combined size limit is 25 MiB"),
	}, async ({ mailboxId, emailId, ...params }) => {
		const denied = await verifyMailbox(mailboxId);
		return denied || mcpResult(await toolForwardEmail(env, mailboxId, emailId, params));
	});

	// ── draft_reply ────────────────────────────────────────────
	register(
		"draft_reply",
		"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			originalEmailId: z
				.string()
				.describe("The ID of the email being replied to"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line (usually 'Re: ...')"),
			bodyHtml: z
				.string()
				.describe("The HTML body of the reply"),
		},
		async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolDraftReply(env, mailboxId, {
				originalEmailId,
				to,
				subject,
				body: bodyHtml,
				isPlainText: false,
				runVerifyDraft: true,
			});
			return mcpResult(result);
		},
	);

	// ── create_draft ───────────────────────────────────────────
	register(
		"create_draft",
		"Create a new draft email. Can be a new email or a reply draft.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			to: z
				.string()
				.optional()
				.describe("Recipient email address (optional for early drafts)"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the draft"),
			in_reply_to: z
				.string()
				.optional()
				.describe("The ID of the email this draft is replying to (optional)"),
			thread_id: z
				.string()
				.optional()
				.describe("Thread ID to attach this draft to (optional)"),
		},
		async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolDraftEmail(env, mailboxId, {
				to: to || "",
				subject,
				body: bodyHtml,
				isPlainText: false,
				runVerifyDraft: true,
				in_reply_to,
				thread_id,
			});
			if ("error" in result) {
				return mcpResult(result);
			}
			// Map the response to match the original create_draft output shape
			return mcpText({
				status: "draft_created",
				draftId: result.draftId,
				threadId: result.threadId,
				message: "Draft created in Drafts folder.",
			});
		},
	);

	// ── update_draft ───────────────────────────────────────────
	register(
		"update_draft",
		"Update an existing draft email's content.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			draftId: z.string().describe("The ID of the draft to update"),
			to: z
				.string()
				.optional()
				.describe("Updated recipient email address"),
			subject: z.string().optional().describe("Updated subject line"),
			bodyHtml: z.string().optional().describe("Updated HTML body"),
		},
		async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolUpdateDraft(env, mailboxId, {
				draftId,
				to,
				subject,
				bodyHtml,
			});
			if ("error" in result) {
				if (result.error === "Draft not found") {
					return {
						content: [{ type: "text" as const, text: "Draft not found" }],
						isError: true,
					};
				}
				return mcpResult(result);
			}
			return mcpText(result);
		},
	);

	// ── delete_email ───────────────────────────────────────────
	register(
		"delete_email",
		"Permanently delete an email by ID.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			emailId: z.string().describe("The email ID to delete"),
		},
		async ({ mailboxId, emailId }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolDeleteEmail(env, mailboxId, emailId);
			return mcpResult(result);
		},
	);

	// ── send_reply ─────────────────────────────────────────────
	register(
		"send_reply",
		"Send a reply to an email. Only call after drafting and getting confirmation.",
		{
			mailboxId: z.string().describe("The mailbox email address to send from"),
			originalEmailId: z
				.string()
				.describe("The ID of the email being replied to"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the reply"),
		},
		async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolSendReply(env, mailboxId, {
				originalEmailId,
				to,
				subject,
				bodyHtml,
			});
			if ("error" in result) {
				// Preserve the original MCP error format for send failures
				if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
					return {
						content: [{ type: "text" as const, text: result.error }],
						isError: true,
					};
				}
				if (result.error === "Original email not found") {
					return {
						content: [{ type: "text" as const, text: "Original email not found" }],
						isError: true,
					};
				}
				return mcpResult(result);
			}
			return mcpText(result);
		},
	);

	// ── send_email ─────────────────────────────────────────────
	register(
		"send_email",
		"Send a new email (not a reply). Only call after getting confirmation.",
		{
			mailboxId: z.string().describe("The mailbox email address to send from"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the email"),
		},
		async ({ mailboxId, to, subject, bodyHtml }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolSendEmail(env, mailboxId, {
				to,
				subject,
				bodyHtml,
			});
			if ("error" in result) {
				if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
					return {
						content: [{ type: "text" as const, text: result.error }],
						isError: true,
					};
				}
				return mcpResult(result);
			}
			return mcpText(result);
		},
	);

	// ── mark_email_read ────────────────────────────────────────
	register(
		"mark_email_read",
		"Mark an email as read or unread.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			emailId: z.string().describe("The email ID"),
			read: z.boolean().describe("true to mark as read, false for unread"),
		},
		async ({ mailboxId, emailId, read }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolMarkEmailRead(env, mailboxId, emailId, read);
			return mcpText(result);
		},
	);

	// ── move_email ─────────────────────────────────────────────
	register(
		"move_email",
		"Move an email to a system or custom folder. Use list_folders to discover folder IDs.",
		{
			mailboxId: z.string().describe("The mailbox email address"),
			emailId: z.string().describe("The email ID"),
			folderId: z
				.string()
				.describe(`${MOVE_FOLDER_TOOL_DESCRIPTION}, or a custom folder ID from list_folders`),
		},
		async ({ mailboxId, emailId, folderId }) => {
			const denied = await verifyMailbox(mailboxId);
			if (denied) return denied;
			const result = await toolMoveEmail(env, mailboxId, emailId, folderId);
			if ("error" in result) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: "Failed to move email" }),
						},
					],
					isError: true,
				};
			}
			return mcpText(result);
		},
	);
}
