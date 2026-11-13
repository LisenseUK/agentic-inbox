import assert from "node:assert/strict";
import { test } from "node:test";
import { formatThreadForClipboard, htmlToPlainText } from "../app/lib/thread-text";
import type { Email } from "../app/types";

const base = { read: true, starred: false, subject: "Hello" } as Email;

test("strips markup, quoted replies and signatures", () => {
	const html = `<style>p{}</style><p>Hi&nbsp;Bob &amp; Al</p><p>See <a href="https://x.io">docs</a></p><div>Thanks</div><br>On Mon, 1 Jan 2026, Bob wrote:<br><blockquote>old<blockquote>older</blockquote></blockquote>`;
	assert.equal(htmlToPlainText(html), "Hi Bob & Al\n\nSee docs (https://x.io)\n\nThanks");
	assert.equal(htmlToPlainText("Hey\n> quoted\n-- \nSig"), "Hey");
});

test("formats oldest first with attachments", () => {
	const out = formatThreadForClipboard(
		[
			{ ...base, id: "2", sender: "b@x.com", recipient: "a@x.com", date: "2026-01-02T10:00:00Z", body: "<p>Reply</p>" },
			{ ...base, id: "1", sender: "a@x.com", recipient: "b@x.com", date: "2026-01-01T10:00:00Z", body: "First", attachments: [{ id: "a", filename: "f.pdf", mimetype: "", size: 1 }] },
		],
		"Hello",
	);
	assert.ok(out.startsWith("Subject: Hello\n\nFrom: a@x.com"));
	assert.ok(out.indexOf("First") < out.indexOf("Reply"));
	assert.ok(out.includes("Attachments: f.pdf"));
});
