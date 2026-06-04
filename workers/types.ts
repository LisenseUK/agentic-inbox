// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Optional Discord incoming webhook URL. When set, a notification is posted for every inbound email. */
	DISCORD_WEBHOOK_URL?: string;
	/** Optional catch-all mailbox address. Receives mail destined for any address that has no dedicated mailbox. */
	CATCH_ALL_MAILBOX?: string;
}
