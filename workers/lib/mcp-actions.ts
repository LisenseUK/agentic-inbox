// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getMailboxStub } from "./email-helpers";
import { folderSlug } from "../../shared/folders";
import type { SearchFilterOptions } from "../durableObject";
import type { Env } from "../types";

export async function toolSearchEmailPage(env: Env, mailboxId: string, params: SearchFilterOptions & { page: number; limit: number }) {
	const stub = await getMailboxStub(env, mailboxId);
	const emails: unknown[] = await stub.searchEmails(params);
	const totalCount = await stub.countSearchResults(params);
	return { emails, totalCount, page: params.page, limit: params.limit };
}

export async function toolListFolders(env: Env, mailboxId: string) {
	return (await getMailboxStub(env, mailboxId)).getFolders();
}

export async function toolCreateFolder(env: Env, mailboxId: string, name: string) {
	const id = folderSlug(name);
	if (!id) return { error: "Folder name must contain alphanumeric characters" };
	const result = await (await getMailboxStub(env, mailboxId)).createFolder(id, name);
	return result ? { id: result.id, name: result.name, unreadCount: result.unreadCount } : { error: "Folder with this name already exists" };
}

export async function toolMarkThreadRead(env: Env, mailboxId: string, threadId: string) {
	const stub = await getMailboxStub(env, mailboxId);
	if (!(await stub.countEmails({ thread_id: threadId }))) return { error: "Thread not found" };
	await stub.markThreadRead(threadId);
	return { threadId, markedRead: true };
}

export async function toolStarEmail(env: Env, mailboxId: string, emailId: string, starred: boolean) {
	const email = await (await getMailboxStub(env, mailboxId)).updateEmail(emailId, { starred });
	return email ? { emailId, starred: email.starred } : { error: "Email not found" };
}
