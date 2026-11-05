// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	PlugsIcon,
	WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? "Copied!" : "Copy"} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={
					copied ? (
						<CheckIcon size={12} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={12} />
					)
				}
				onClick={handleCopy}
				aria-label="Copy to clipboard"
			/>
		</Tooltip>
	);
}

const TOOLS = [
	{ name: "list_mailboxes", desc: "List all mailboxes" },
	{ name: "create_mailbox", desc: "Create an inbox" },
	{ name: "delete_mailbox", desc: "Remove an inbox" },
	{ name: "list_emails", desc: "List emails in a folder" },
	{ name: "get_email", desc: "Read a full email with body" },
	{ name: "get_thread", desc: "Load a conversation thread" },
	{ name: "search_emails", desc: "Search emails with filters and pagination" },
	{ name: "get_attachment", desc: "Download an attachment" },
	{ name: "list_folders", desc: "List folders and unread counts" },
	{ name: "create_folder", desc: "Create a custom folder" },
	{ name: "forward_email", desc: "Forward an email and its attachments" },
	{ name: "mark_thread_read", desc: "Mark a conversation as read" },
	{ name: "star_email", desc: "Star or unstar an email" },
	{ name: "draft_reply", desc: "Draft a reply to an email" },
	{ name: "create_draft", desc: "Create a draft email" },
	{ name: "update_draft", desc: "Update a draft email" },
	{ name: "delete_email", desc: "Permanently delete an email" },
	{ name: "send_reply", desc: "Send a reply" },
	{ name: "send_email", desc: "Send a new email" },
	{ name: "mark_email_read", desc: "Mark email as read/unread" },
	{ name: "move_email", desc: "Move email to a folder" },
];

export default function MCPPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "https://your-app.workers.dev";
	const mcpUrl = `${baseUrl}/mcp`;

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
				{/* Intro */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand/10">
							<PlugsIcon
								size={20}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-kumo-default">
								Connect via MCP
							</h3>
							<p className="text-xs text-kumo-subtle">
								Model Context Protocol
							</p>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						This email agent exposes an MCP server so AI coding
						assistants can manage your inbox directly — read emails,
						search, draft replies, and send messages using natural
						language.
					</p>
				</div>

				{/* MCP URL */}
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-kumo-strong block">
						Server URL
					</label>
					<div className="relative group">
						<div className="absolute right-1.5 top-1/2 -translate-y-1/2">
							<CopyButton text={mcpUrl} />
						</div>
						<div className="bg-kumo-recessed text-kumo-default font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-kumo-line break-all leading-relaxed">
							{mcpUrl}
						</div>
					</div>
				</div>

				<div className="space-y-2">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						Events
					</h4>
					<div className="border border-kumo-line rounded-lg p-3 space-y-2">
						<p className="text-xs font-mono font-medium text-kumo-default">email.received</p>
						<p className="text-xs text-kumo-subtle leading-relaxed">
							Ask ChatGPT to monitor new mail and react when it arrives. Filter by mailbox,
							sender, or subject. Use a Work chat on the web, or Work with Cloud in the desktop app.
						</p>
						<p className="text-xs text-kumo-default leading-relaxed">
							Watch {mailboxId || "my mailbox"} for new emails with "invoice" in the subject
							and summarize each one.
						</p>
					</div>
				</div>

				{/* Available tools */}
				<div className="space-y-2">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						Available Tools
					</h4>
					<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
						{TOOLS.map((tool) => (
							<div
								key={tool.name}
								className="flex items-center gap-2.5 px-3 py-2"
							>
								<WrenchIcon
									size={12}
									weight="bold"
									className="text-kumo-brand shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<span className="text-xs font-mono font-medium text-kumo-default">
										{tool.name}
									</span>
								</div>
								<span className="text-[11px] text-kumo-subtle shrink-0">
									{tool.desc}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
