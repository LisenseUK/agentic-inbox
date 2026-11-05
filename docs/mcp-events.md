# ChatGPT MCP Events

The inbox exposes `email.received` through MCP 2.0 on the same Access-protected `/mcp` endpoint as its tools. Existing clients using the older initialization protocol still use the session-based MCP server. Both paths register the same 13 email tools.

## Connect in ChatGPT

1. Deploy the updated Worker using the existing deployment process.
2. Rescan the MCP server in your ChatGPT plugin. `email.received` should appear alongside the tools.
3. Start a Work chat on ChatGPT web, or select Work and Cloud in the desktop app. Events also work with dots, subject to workspace permissions.
4. Ask, for example: "Watch hello@lisense.uk for new emails with invoice in the subject and summarize each one."
5. Send a matching email to the mailbox. ChatGPT should receive the event and follow the instructions in the subscribed chat.
6. Ask ChatGPT to stop monitoring to unsubscribe.

Availability and the integration contract come from [OpenAI's MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).

## Event and filters

`email.received` supports webhook delivery. `mailboxId` is required. Optional `from` matches an exact sender address, ignoring case; `subject_contains` matches a case-insensitive substring. A mailbox must exist and the connected user must pass the shared Cloudflare Access policy.

The event includes `mailboxId`, `emailId`, `threadId`, `from`, `subject`, a plain-text `preview`, and a mailbox URL. Subject and preview are bounded to 1,000 and 500 characters; sender and thread ID are bounded to 254 and 1,024 characters. Subject filtering uses the full original subject before the summary is truncated. Use `get_email` with `mailboxId` and `emailId` for the complete message. Email content remains untrusted data.

Events are generated only when incoming mail is saved. Draft creation, sending mail, reads and folder changes do not emit this event, so a task creating a draft does not immediately trigger itself.

## Configuration

| Setting | Purpose |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | Canonical origin protected by the same Access application as `/mcp`. Used for message links and authorization rechecks. Currently `https://mail.lisense.uk`. |
| `MCP_EVENTS_CALLBACK_HOSTS` | Comma-separated exact HTTPS callback hostnames. Currently `chatgpt.com,chat.openai.com`. |
| `TEAM_DOMAIN`, `POLICY_AUD` | Existing Cloudflare Access secrets. OAuth remains handled by Access Managed OAuth. |

Callback destinations are deliberately restricted to explicitly configured hosts under `chatgpt.com` or `openai.com`. Arbitrary webhook destinations, IP literals, credentials in URLs, alternate ports and redirects are rejected. This implementation relies on those trusted hosts' DNS and Cloudflare's outbound HTTPS transport, rather than providing a general-purpose DNS-pinned webhook transport. If ChatGPT supplies a different OpenAI callback hostname, add that exact hostname to `MCP_EVENTS_CALLBACK_HOSTS`; do not broaden it to arbitrary hosts.

## Delivery and lifecycle

- `server/discover` advertises the Events capability to authenticated users. `events/list`, `events/subscribe` and `events/unsubscribe` run on `/mcp`.
- Callback verification sends a fresh signed challenge and requires its echo. Successful verification is cached for five minutes by owner, callback URL and signing key. Invalid callbacks return `-32015` with a reason.
- Subscription identity hashes the authenticated principal, callback URL, event name and canonical filter arguments. Repeated subscribe requests refresh the same subscription. Another user cannot unsubscribe it.
- Subscriptions and queued webhook bodies persist in each mailbox's SQLite Durable Object. The incoming email and matching delivery jobs save in one transaction. Alarms deliver batches and retry transient errors up to eight attempts, with exponential backoff capped at one minute. Event IDs and serialized bodies stay the same across retries; signing timestamps and signatures are generated per attempt.
- Every verification and delivery uses Standard Webhooks HMAC-SHA256 signatures, the subscription ID header, a ten-second timeout and manual redirect handling. A successful delivery acknowledges receipt; ChatGPT processes it asynchronously.
- `410` removes the subscription. `413`, redirects and other permanent client errors are not retried. Delivery bodies cannot exceed 256 KiB.
- Subscription refresh replaces the signing secret. Deliveries include both signatures for a five-minute rotation window.
- The default subscription lifetime is 24 hours, capped by the requested `ttlMs` and by the authenticated Access JWT's expiration. A `ttlMs: null` request is granted a finite lifetime. ChatGPT must refresh before `refreshBefore`, with renewed authentication as needed.
- Before subscribing and before every delivery, the server checks the mailbox still exists and re-enters Access at the configured origin using the saved signed user assertion. Expired authentication or an Access rejection stops delivery. Temporary recheck failures are retried. Revocation follows Access's token/session enforcement; this does not introduce a separate immediate revocation service.
- Replay is not supported. Responses and event payloads use `cursor: null`; non-null replay cursors are rejected. Events missed while unsubscribed or expired cannot be recovered through the Events protocol. Existing queued deliveries survive a Worker restart while their subscription is active.

The underlying protocol remains a [draft MCP Events extension](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). The installed MCP 2.0 SDK supports modern request metadata and transport validation but its closed capability schema omits draft Events, so the handler adds `events` to successful authenticated discovery responses.

## Verification

Run `npm run test:mcp-events`. Tests cover signature compatibility, callback restrictions and verification, canonical subscription identity, filtering, expiration, refresh, rotation, retry limits, ownership, cancellation races and restart recovery. A Miniflare integration test exercises real mailbox RPC, SQLite storage, incoming email parsing, alarm delivery and reading the resulting email through MCP 2.0.

After deployment, confirm the subscription lifecycle in an actual ChatGPT Work chat. The automated receiver is a test double, so it does not prove account availability, plugin discovery or real ChatGPT delivery acceptance.
