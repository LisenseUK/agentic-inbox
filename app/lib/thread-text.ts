import type { Email } from "../types";

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&(?:#39|apos);/g, "'")
		.replace(/&amp;/g, "&");
}

/** Remove the nested quoted-reply markup that mail clients append to replies. */
function removeQuotedReplies(html: string): string {
	let out = html;
	// Blockquotes can nest, so peel the innermost ones until none remain.
	const innermost = /<blockquote\b(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi;
	for (let prev = ""; prev !== out; ) {
		prev = out;
		out = out.replace(innermost, "");
	}
	return out
		.replace(/<blockquote\b[\s\S]*$/i, "")
		.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, "");
}

/** Convert an HTML email body to readable plain text, keeping paragraph breaks. */
export function htmlToPlainText(html: string): string {
	const isHtml = /<[a-z][\s\S]*>/i.test(html);
	let text = isHtml
		? removeQuotedReplies(html)
				.replace(/<!--[\s\S]*?-->/g, "")
				.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, "\n\n")
				.replace(/<li\b[^>]*>/gi, "\n- ")
				.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
					const l = label.replace(/<[^>]*>/g, "").trim();
					return !l || l === href || href.startsWith("mailto:") ? l || href : `${l} (${href})`;
				})
				.replace(/<[^>]*>/g, "")
		: html;
	text = decodeHtmlEntities(text).replace(/ /g, " ").replace(/\r\n?/g, "\n");

	// Drop plain-text quoted lines, the "On … wrote:" lead-in and the signature delimiter.
	const lines = text.split("\n");
	const sig = lines.findIndex((l) => /^--\s?$/.test(l));
	const kept = (sig >= 0 ? lines.slice(0, sig) : lines).filter((l) => !/^\s*>/.test(l));
	text = kept.join("\n").replace(/\n?\s*On .{5,200}wrote:\s*$/s, "");

	return text
		.split("\n")
		.map((l) => l.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Format a thread for the clipboard: subject, then each message oldest-first with
 * sender, date, recipients and cleaned body. Attachments are listed by filename.
 */
export function formatThreadForClipboard(messages: Email[], subject: string): string {
	const sorted = [...messages].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	const parts = sorted.map((m) => {
		const date = new Date(m.date);
		const header = [
			`From: ${m.sender}`,
			`To: ${m.recipient}`,
			m.cc ? `Cc: ${m.cc}` : "",
			`Date: ${Number.isNaN(date.getTime()) ? m.date : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
		].filter(Boolean);
		const body = htmlToPlainText(m.body || "") || "(no content)";
		const files = m.attachments?.length ? `\n\nAttachments: ${m.attachments.map((a) => a.filename).join(", ")}` : "";
		return `${header.join("\n")}\n\n${body}${files}`;
	});
	return `Subject: ${subject || "(no subject)"}\n\n${parts.join("\n\n---\n\n")}\n`;
}
