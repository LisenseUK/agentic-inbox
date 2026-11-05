// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { ApiError } from "~/services/api";
import type { Mailbox } from "~/types";
import { queryKeys } from "./keys";

export function useMailboxes() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes() as Promise<Mailbox[]>,
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
		retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
	});
}

export function useBlockedMailboxes() {
	return useQuery({ queryKey: queryKeys.blockedMailboxes, queryFn: api.listBlockedMailboxes });
}

function useRefreshMailboxAccess() {
	const qc = useQueryClient();
	return async (mailboxId: string) => {
		const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey.includes(mailboxId);
		await qc.cancelQueries({ predicate });
		qc.removeQueries({ predicate });
		await Promise.all([
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all }),
			qc.invalidateQueries({ queryKey: queryKeys.blockedMailboxes }),
			qc.invalidateQueries({ queryKey: queryKeys.config }),
		]);
	};
}

export function useBlockMailbox() {
	const refresh = useRefreshMailboxAccess();
	return useMutation({ mutationFn: api.blockMailbox, onSuccess: (_data, email) => refresh(email) });
}

export function useUnblockMailbox() {
	const refresh = useRefreshMailboxAccess();
	return useMutation({ mutationFn: api.unblockMailbox, onSuccess: (_data, email) => refresh(email) });
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name }: { email: string; name: string }) =>
			api.createMailbox(email, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: unknown }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
