import assert from "node:assert/strict";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";

// Read-only discovery check. Does not register a client or request tokens.
const server = new URL(process.argv[2] || "https://mail.lisense.uk/mcp");
const userAgent = process.argv[3];
const fetchProbe = (input, init = {}) => {
	const headers = new Headers(init.headers);
	if (userAgent) headers.set("User-Agent", userAgent);
	return fetch(input, { ...init, headers, signal: AbortSignal.timeout(15_000) });
};

try {
	const response = await fetchProbe(server, {
		headers: { Accept: "application/json, text/event-stream" },
		redirect: "manual",
	});
	assert.equal(response.status, 401, `Expected OAuth challenge, received HTTP ${response.status}`);
	const challenge = extractWWWAuthenticateParams(response);
	assert.ok(challenge.resourceMetadataUrl, "OAuth challenge has no resource metadata URL");
	const resource = await discoverOAuthProtectedResourceMetadata(
		server, { resourceMetadataUrl: challenge.resourceMetadataUrl }, fetchProbe,
	);
	assert.equal(resource.resource, server.href, "OAuth resource does not match the MCP URL");
	assert.ok(resource.authorization_servers?.length, "No authorization server advertised");
	const metadata = await discoverAuthorizationServerMetadata(resource.authorization_servers[0], {
		fetchFn: fetchProbe,
	});
	assert.ok(metadata.authorization_endpoint, "No authorization endpoint advertised");
	assert.ok(metadata.token_endpoint, "No token endpoint advertised");
	assert.ok(metadata.registration_endpoint, "No dynamic client registration endpoint advertised");
	assert.ok(metadata.code_challenge_methods_supported?.includes("S256"), "PKCE S256 is unavailable");
	assert.ok(metadata.grant_types_supported?.includes("refresh_token"), "Refresh tokens are unavailable");
	console.log(`PASS: OAuth discovery, client registration metadata, PKCE and refresh metadata for ${server.href}`);
	console.log("Browser login, token exchange, refresh and MCP tool calls still require an authenticated client.");
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
}
