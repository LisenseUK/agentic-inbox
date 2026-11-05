import { Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { useBlockedMailboxes, useBlockMailbox, useUnblockMailbox } from "~/queries/mailboxes";

export function meta() {
	return [{ title: "Blocked inboxes | Lisense Mail" }];
}

export default function BlockedInboxesRoute() {
	const { data: mailboxes = [], isPending, isError, refetch } = useBlockedMailboxes();
	const block = useBlockMailbox();
	const unblock = useUnblockMailbox();
	const toast = useKumoToastManager();
	const [email, setEmail] = useState("");

	async function handleBlock(event: FormEvent) {
		event.preventDefault();
		try {
			await block.mutateAsync(email.trim().toLowerCase());
			setEmail("");
			toast.add({ title: "Inbox blocked" });
		} catch (error) {
			toast.add({ title: error instanceof Error ? error.message : "Could not block inbox", variant: "error" });
		}
	}

	async function handleUnblock(address: string) {
		try {
			await unblock.mutateAsync(address);
			toast.add({ title: "Inbox unblocked" });
		} catch {
			toast.add({ title: "Could not unblock inbox", variant: "error" });
		}
	}

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<main className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<Link prefetch="intent" to="/" className="text-sm text-kumo-subtle hover:text-kumo-default">Back to mailboxes</Link>
				<h1 className="mt-6 text-2xl font-bold text-kumo-default">Blocked inboxes</h1>
				<p className="mt-2 text-sm text-kumo-subtle">
					Blocked inboxes are hidden and stop receiving mail, notifications, and automatic drafts. Existing mail and settings are kept for when you unblock them.
				</p>
				<form onSubmit={handleBlock} className="my-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-0 flex-1">
							<Input label="Email address to block" type="email" placeholder="inbox@snailbox.live" value={email} onChange={(event) => setEmail(event.target.value)} required />
						</div>
						<Button type="submit" variant="destructive" loading={block.isPending}>Block inbox</Button>
					</div>
					<p className="mt-3 text-xs text-kumo-subtle">You can also block an address before its first email arrives.</p>
				</form>
				{isPending ? <div className="flex justify-center py-10"><Loader /></div> : isError ? (
					<div role="alert" className="text-sm text-kumo-default">Could not load blocked inboxes. <Button variant="secondary" onClick={() => refetch()}>Try again</Button></div>
				) : mailboxes.length === 0 ? (
					<p className="rounded-xl border border-kumo-line bg-kumo-base p-8 text-center text-sm text-kumo-subtle">No blocked inboxes.</p>
				) : (
					<ul className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{mailboxes.map((mailbox) => (
							<li key={mailbox.id} className="flex items-center gap-4 p-5">
								<span className="min-w-0 flex-1 break-all text-sm text-kumo-default">{mailbox.email}</span>
								<Button variant="secondary" size="sm" loading={unblock.isPending && unblock.variables === mailbox.email} disabled={unblock.isPending} onClick={() => handleUnblock(mailbox.email)} aria-label={`Unblock ${mailbox.email}`}>Unblock</Button>
							</li>
						))}
					</ul>
				)}
			</main>
		</div>
	);
}
