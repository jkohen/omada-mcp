import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const clientId = process.env.OAUTH_CLIENT_ID || 'omada_gemini_client';
const staticToken = process.env.STATIC_OAUTH_TOKEN || process.env.OAUTH_CLIENT_SECRET || 'test_oauth_client_secret';

async function runAuthTests() {
  console.log('=== Running Omada MCP Authentication Tests ===\n');

  // 1. Unauthenticated request to /mcp MUST be rejected with 401
  console.log('1. Testing unauthenticated POST /mcp rejection...');
  const res1 = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.strictEqual(res1.status, 401, `Expected 401 Unauthorized, got ${res1.status}`);
  const data1 = await res1.json();
  assert.strictEqual(data1.error, 'unauthorized');
  assert.ok(res1.headers.get('www-authenticate')?.includes('Bearer'), 'Missing WWW-Authenticate header');
  console.log('   ✅ PASS: Unauthenticated request rejected with 401 Unauthorized');

  // 2. Invalid Bearer token MUST be rejected with 401
  console.log('2. Testing invalid Bearer token rejection...');
  const res2 = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer invalid_secret_token_value',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.strictEqual(res2.status, 401, `Expected 401 Unauthorized, got ${res2.status}`);
  const data2 = await res2.json();
  assert.strictEqual(data2.error, 'invalid_token');
  console.log('   ✅ PASS: Invalid Bearer token rejected with 401 invalid_token');

  // 3. Static OAuth token MUST be accepted and allow MCP tool listing
  console.log('3. Testing static OAuth token connection via StreamableHTTP...');
  const transportStatic = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${staticToken}`
        }
      }
    }
  );
  const clientStatic = new Client(
    { name: 'test-auth-static', version: '1.0.0' },
    { capabilities: {} }
  );
  await clientStatic.connect(transportStatic);
  const toolsStatic = await clientStatic.listTools();
  assert.ok(toolsStatic.tools?.length > 0, 'Tools list should not be empty');
  await clientStatic.close();
  console.log(`   ✅ PASS: Static OAuth token accepted (${toolsStatic.tools.length} tools available)`);

  // 4. Token endpoint with invalid secret MUST be rejected
  console.log('4. Testing /oauth/token with invalid client secret...');
  const badTokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=wrong_secret`
  });
  assert.strictEqual(badTokenRes.status, 401, `Expected 401 for bad secret, got ${badTokenRes.status}`);
  console.log('   ✅ PASS: Bad client secret rejected with 401');

  // 5. Full OAuth 2.0 Client Credentials flow MUST be accepted with JWT
  console.log('5. Testing OAuth 2.0 Client Credentials flow and JWT MCP connection...');
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${staticToken}`
  });
  assert.strictEqual(tokenRes.status, 200, `Expected 200 from /oauth/token, got ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  assert.ok(tokenData.access_token, 'Access token missing in response');

  const transportJwt = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        }
      }
    }
  );
  const clientJwt = new Client(
    { name: 'test-auth-jwt', version: '1.0.0' },
    { capabilities: {} }
  );
  await clientJwt.connect(transportJwt);
  const toolsJwt = await clientJwt.listTools();
  assert.ok(toolsJwt.tools?.length > 0, 'Tools list should not be empty');
  await clientJwt.close();
  console.log(`   ✅ PASS: Dynamic OAuth JWT accepted (${toolsJwt.tools.length} tools available)`);

  console.log('\n=== All Authentication Tests Passed Successfully! ===');
}

runAuthTests().catch(err => {
  console.error('\n❌ Authentication Test Failed:', err);
  process.exit(1);
});
