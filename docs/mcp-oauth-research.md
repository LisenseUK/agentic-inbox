# MCP OAuth investigation

Researched 7 October 2026 against official Cloudflare documentation.

## Recommendation

Keep Cloudflare Access Managed OAuth for this MCP. The existing Worker validates `Cf-Access-Jwt-Assertion` with the Access issuer, signing keys and application audience. That is the integration Cloudflare requires for Managed OAuth. Implementing another OAuth provider in this Worker would add a separate authorization system without resolving a request blocked before the Worker. [Managed OAuth docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

The live Access application for `mail.lisense.uk` already has Managed OAuth and dynamic client registration enabled. Its destinations include `mail.lisense.uk` and `mail.lisense.uk/mcp`. Allowed redirects include ChatGPT's `connector/oauth/*` and `connector_platform_oauth_redirect`; localhost and loopback clients are allowed. These settings were verified through the Cloudflare API during this investigation. They are not missing configuration that needs enabling.

A Python HTTP probe to the deployed hostname received HTTP 403, Cloudflare error 1010 and `browser_signature_banned`, without a `WWW-Authenticate` challenge. The installed MCP SDK, using Node's normal fetch headers, successfully completed discovery. The failure depends on request headers, and does not establish that the intended MCP client fails for the same reason.

## Live checks

Read-only checks against `https://mail.lisense.uk/mcp` produced these results:

| Check | Result |
| --- | --- |
| Unauthenticated Node and curl requests to `/mcp` | HTTP 401 with a Bearer challenge |
| Challenge's resource metadata URL | `https://mail.lisense.uk/.well-known/cloudflare-access-protected-resource/mcp`, HTTP 200 |
| Advertised resource | `https://mail.lisense.uk/mcp` |
| Advertised authorization server | `https://harrisonhass.cloudflareaccess.com` |
| SDK authorization server discovery | Authorization, token, registration and revocation endpoints found |
| PKCE | `S256` advertised |
| Grants | `authorization_code` and `refresh_token` advertised |
| Python user agent | HTTP 403, error 1010, before OAuth discovery |
| Zone Browser Integrity Check | Enabled |
| Zone user agent blocking rules | None |
| Worker settings | `POLICY_AUD` and `TEAM_DOMAIN` secrets present, values not readable through settings |
| Access policy | One email-based Allow policy, no additional requirements |
| MCP transport in installed Agents SDK | `EmailMCP.serve` defaults to Streamable HTTP |

These results were observed on 7 October 2026 local time. Metadata support does not prove token issuance, refresh or authenticated tool access.

Run `node scripts/check-mcp-oauth.mjs` to repeat the discovery checks using the installed MCP SDK. Supply a different endpoint as the first argument and an optional user agent as the second. It does not register clients or request tokens.

The existing application allows `https://chatgpt.com/connector/oauth/*` and `https://chatgpt.com/connector_platform_oauth_redirect`, plus localhost and loopback callbacks. Compare the failing client's actual callback against those entries. Use the custom hostname above; the enabled `agentic-inbox.hcampbell.workers.dev` hostname is not listed among this Access application's destinations.

## Header-dependent security rejection

Browser Integrity Check is the leading explanation for the Python probe's error 1010. Cloudflare documents that BIC rejects suspicious headers and nonstandard user agents. No zone user agent blocking rules were returned by the API. This finding is specific to the probe until the intended client's error is known. [Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)

If the intended client also receives that rejection, configure a narrow rule to skip only BIC on the MCP and discovery paths. A proposed custom rule filter is:

```text
(http.host eq "mail.lisense.uk" and (
  http.request.uri.path eq "/mcp"
  or starts_with(http.request.uri.path, "/mcp/")
  or starts_with(http.request.uri.path, "/.well-known/")
))
```

Use action `skip` and `action_parameters.products: ["bic"]`. This skips the browser header check for matching requests; Access still requires user authorization. Do not skip all WAF rules or disable BIC for the whole zone to address this narrow problem. A configuration rule with `bic: false` is another documented option. No rule was applied during this investigation. [Skip products](https://developers.cloudflare.com/waf/custom-rules/skip/options/#skip-products), [configuration rule settings](https://developers.cloudflare.com/rules/configuration-rules/settings/#browser-integrity-check)

## Verified protocol behavior

- Managed OAuth works on self-hosted Access applications. Cloudflare explicitly supports MCP applications served through Cloudflare in the same account as the Zero Trust organization. It requires an RFC 8707 compatible client. [Managed OAuth prerequisites and MCP setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- Access replaces the usual non-browser HTTP 302 login redirect with HTTP 401 and a `WWW-Authenticate` discovery challenge. The authorization server metadata is available at `https://<app-domain>/.well-known/oauth-authorization-server`. Access handles the browser login and authorization code flow. [Authorization flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#authorization-flow)
- The MCP client receives an opaque OAuth token, such as `oauth:...`, rather than a JWT. Access resolves that token and sends the origin a JWT in `Cf-Access-Jwt-Assertion`. The Worker should validate that header, not attempt to verify the opaque bearer token as a JWT. [Token format](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#token-format), [linked app limitations](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/linked-apps/#known-limitations)
- Workers support hostname-based Access on custom domains and `workers.dev`. A custom domain is useful for a stable endpoint, but Workers hosting does not force an OAuth implementation in the Worker. [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path)
- The Worker must use the audience of the application that protects the endpoint. `POLICY_AUD` is the Access application's AUD tag, and `TEAM_DOMAIN` is `https://<team>.cloudflareaccess.com`. Creating a separate `/mcp` Access application would require validating its separate audience on MCP requests. The current single audience validator works with the existing shared application. [Official JWT validator example](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), `workers/app.ts`

## Configuration reference

In Zero Trust, open Access controls > Applications, edit the application and use Advanced settings > Managed OAuth. This is the setting already enabled on the deployed app. [Dashboard and API instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

For an API change, first GET `/accounts/{account_id}/access/apps/{app_id}`. Preserve the application configuration in the subsequent PUT and modify `oauth_configuration`; do not send only this fragment as a replacement application:

```json
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": true,
      "allow_any_on_loopback": true,
      "allowed_uris": ["https://<actual-client-host>/<actual-callback-path>"]
    },
    "grant": {
      "access_token_lifetime": "15m",
      "session_duration": "24h"
    }
  }
}
```

The example HTTPS redirect is a placeholder, not a suggested change to the existing allowlist. Cloud-hosted clients need their actual HTTPS callback allowed. Localhost and loopback permissions support local CLI callbacks. HTTPS paths may end in `/*`. Cloudflare recommends short access token lifetimes of 5–15 minutes; refresh grants can be longer, with policies reevaluated on refresh. [Managed OAuth settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings)

## When an OAuth provider in the Worker would be appropriate

Cloudflare's `workers-oauth-provider` can implement MCP OAuth while using Access for SaaS as the upstream OIDC provider. That alternative needs OAuth endpoints, authorization and consent handling, token storage, Access SaaS client credentials and a callback. Cloudflare's example lists `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` and `COOKIE_ENCRYPTION_KEY`. [Access for SaaS setup](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/#saas-managed-third-party-mcp-server), [authorization options](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)

Version 1 of `workers-oauth-provider` was announced on 1 October 2026. It also supports separate authorization and resource Workers and protected resource metadata. If choosing that architecture later, use current v1 examples rather than assuming an older example's API is current. [v1 announcement](https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/)

Do not enable Managed OAuth in front of a server that relies on its own OAuth challenges. Cloudflare states that Managed OAuth replaces that HTTP 401 behavior. [Managed OAuth note](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

## Remaining validation

Confirm discovery from the actual MCP client's network and HTTP headers, then complete browser authorization and invoke `list_mailboxes`. Verify token refresh and the deployed Worker's `TEAM_DOMAIN` and `POLICY_AUD` alignment if requests reach the Worker but return `Invalid or expired Access token`. The issuer should be `https://harrisonhass.cloudflareaccess.com` and the audience must match the live `lisense.uk` Access application's AUD tag. The API confirms the secrets exist but does not expose their values. The repository intentionally permits an authorized teammate to access all mailboxes; OAuth preserves that shared Access policy model and does not add per-mailbox permissions.
