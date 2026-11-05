import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { emailListOptions } from "~/queries/emails";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/** Warm the same query cache used by pages, including links supplied by Kumo. */
export function NavigationPrefetch() {
	const client = useQueryClient();
	useEffect(() => {
		const prefetch = (event: Event) => {
			const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return;
			const match = link.pathname.match(/^\/mailbox\/([^/]+)(?:\/emails\/([^/]+))?\/?$/);
			if (!match) return;
			const mailboxId = decodeURIComponent(match[1]);
			const folder = match[2] ? decodeURIComponent(match[2]) : "inbox";
			void client.prefetchQuery({ queryKey: queryKeys.mailboxes.detail(mailboxId), queryFn: () => api.getMailbox(mailboxId) });
			void client.prefetchQuery({ queryKey: queryKeys.folders.list(mailboxId), queryFn: () => api.listFolders(mailboxId) });
			void client.prefetchQuery(emailListOptions(mailboxId, { folder, page: "1", limit: "25" }));
		};
		document.addEventListener("pointerover", prefetch);
		document.addEventListener("focusin", prefetch);
		document.addEventListener("touchstart", prefetch, { passive: true });
		return () => {
			document.removeEventListener("pointerover", prefetch);
			document.removeEventListener("focusin", prefetch);
			document.removeEventListener("touchstart", prefetch);
		};
	}, [client]);
	return null;
}
