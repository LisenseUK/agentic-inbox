import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test("authenticated legacy and modern clients discover and read mailboxes", { timeout: 60_000 }, async () => {
 const bundled = await build({ entryPoints: ["workers/app.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
  conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*", "path"],
  define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
  plugins: [{ name: "unused-ui", setup(build) {
   build.onResolve({ filter: /^virtual:react-router\/server-build$/ }, () => ({ path: "ui", namespace: "test" }));
   build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export default {}" }));
  } }],
 });
 const { publicKey, privateKey } = await generateKeyPair("RS256");
 const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
 const token = await new SignJWT({ email: "tester@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
  .setSubject("tester").setIssuer("https://access.test").setAudience("mail-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
 const mf = new Miniflare({ modules: [{ type: "ESModule", path: "worker.mjs", contents: bundled.outputFiles[0].text }], compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true }, EMAIL_AGENT: { className: "EmailAgent", useSQLite: true }, EMAIL_MCP: { className: "EmailMCP", useSQLite: true } },
  r2Buckets: ["BUCKET"], bindings: { TEAM_DOMAIN: "https://access.test", POLICY_AUD: "mail-test", DOMAINS: "snailbox.live", EMAIL_ADDRESSES: [], MCP_PUBLIC_ORIGIN: "https://mail.lisense.uk" },
  outboundService: async (request) => {
   assert.equal(request.url, "https://access.test/cdn-cgi/access/certs");
   return Response.json({ keys: [jwk] });
  },
 });
 let id = 0;
 async function rpc(version: string, method: string, params: Record<string, unknown> = {}, session?: string, auth: string | null = token) {
  const modern = version === "2026-07-28";
  return mf.dispatchFetch("https://mail.lisense.uk/mcp", { method: "POST", headers: {
   "Content-Type": "application/json", Accept: "application/json, text/event-stream",
   ...(auth ? { "Cf-Access-Jwt-Assertion": auth } : {}),
   ...(session ? { "Mcp-Session-Id": session } : {}),
   ...(method !== "initialize" ? { "MCP-Protocol-Version": version } : {}),
   ...(modern ? { "MCP-Method": method, ...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}) } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++id }), method,
   params: { ...params, ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "compat-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } }) });
 }
 async function result(response: Response) {
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream")
   ? raw.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("") : raw);
  assert.equal(body.error, undefined, JSON.stringify(body));
  return body.result;
 }
 try {
  await (await mf.getR2Bucket("BUCKET")).put("mailboxes/compat@snailbox.live.json", "{}");
  const catalogs: string[][] = [];
  for (const version of ["2025-06-18", "2026-07-28"]) {
   const init = await rpc(version, version === "2025-06-18" ? "initialize" : "server/discover",
    version === "2025-06-18" ? { protocolVersion: version, capabilities: {}, clientInfo: { name: "codex", version: "0.166.0" } } : {});
   const session = init.headers.get("mcp-session-id") ?? undefined;
   const initialized = await result(init);
   if (version === "2025-06-18") {
    assert.equal(initialized.protocolVersion, version);
    assert.ok(session, "Legacy initialization establishes a session");
    assert.equal((await rpc(version, "notifications/initialized", {}, session)).status, 202);
   }
   assert.ok(initialized.capabilities.tools);
   if (version === "2026-07-28") assert.ok(initialized.capabilities.events);
   const tools = await result(await rpc(version, "tools/list", {}, session));
   catalogs.push(tools.tools.map((tool: { name: string }) => tool.name).sort());
   assert.ok(tools.tools.some((tool: { name: string }) => tool.name === "list_mailboxes"));
   const mailboxes = await result(await rpc(version, "tools/call", { name: "list_mailboxes", arguments: {} }, session));
   assert.ok(!mailboxes.isError);
   assert.deepEqual(JSON.parse(mailboxes.content[0].text), [{ id: "compat@snailbox.live", email: "compat@snailbox.live" }]);
   for (const method of ["initialize", "tools/list", "tools/call"]) {
    assert.equal((await rpc(version, method, { name: "list_mailboxes", arguments: {} }, session, null)).status, 403);
    assert.equal((await rpc(version, method, { name: "list_mailboxes", arguments: {} }, session, "invalid")).status, 403);
   }
  }
  assert.deepEqual(catalogs[0], catalogs[1], "Both versions expose the same tool catalog");
 } finally { await mf.dispose(); }
});
