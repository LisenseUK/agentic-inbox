# Mail MCP protocol compatibility

`/mcp` supports the session-based `2025-06-18` protocol through `EmailMCP` (the v1 SDK / Agents transport), and the per-request `2026-07-28` protocol through the v2 SDK handler. Both register the same email tools. Modern Events remain on the modern handler.

The compatibility regression was argument placement: `isLegacyRequest(request, parsedBody?, options?)` was given `{ maxRequestBodySize: ... }` as its second argument. The classifier treated that object as the request body and routed legacy initialization to the modern-only handler, which returned `-32022`. Pass `undefined` as the second argument to read a clone of the actual request body, and pass limits as the third argument. The original body remains available to the selected transport.

Cloudflare Access Managed OAuth and JWT validation still protect both transports before protocol selection. A 401 from an unauthenticated request is expected and says nothing about stored client credentials. No OAuth reset or application policy change is required for this routing fix.

## Validation

Run `npm run test:mcp-compat`. It bundles the production Worker, stubbing only the unused UI build, and runs it in Miniflare with real MCP transports and R2 storage. It signs an Access JWT with an ephemeral test key and serves the matching JWKS locally. It verifies legacy initialization and its initialized notification, modern `server/discover` (the modern initialization equivalent), tool discovery, a read-only `list_mailboxes` call, and missing/invalid authentication rejection for both versions. Reverting the two classifier calls reproduces the exact unsupported-version error.

`npm run test:mcp-events` and `npm run test:mcp-tools` cover the existing modern Events and shared tools behavior.

## Deployment and reconnection

Deployment requires explicit user authorization. The fix branch includes the existing local server prerequisites for the modern handler because these were not present on remote `main`; unrelated local UI changes are excluded. Review the complete PR before deployment.

After authorization, deploy through the existing authenticated Worker deployment process (`npm run deploy`). Retain the existing `POLICY_AUD` and `TEAM_DOMAIN` secrets and Cloudflare Access Managed OAuth configuration; do not loosen Access or change stored client credentials. No new Durable Object class migration is required.

After deployment, restart/reconnect the T3 Code Codex MCP client so startup runs again against `https://mail.lisense.uk/mcp`. Verify the client no longer logs `Unsupported protocol version: 2025-06-18`, the server reaches ready state, and `list_mailboxes` succeeds. Only investigate OAuth separately if the authenticated connection then reports an authentication error.

Finally, use the returned mailbox IDs to search One Auto API / OneAuto correspondence for AutoCheck verification. Search sender, subject and message text, read matching threads and summarize the requested verification steps and current status. Do not send mail. This live verification and correspondence search remain pending deployment and connection reload.
