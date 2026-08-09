import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function testLocalSse() {
  const host = process.env.GATEWAY_HOST || 'http://127.0.0.1:3000';
  console.log(`Connecting to local MCP SSE server at ${host}/sse...`);
  
  const transport = new SSEClientTransport(
    new URL(`${host}/sse`)
  );

  const client = new Client(
    { name: 'local-test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✅ SSE Connection established!');

  const tools = await client.listTools();
  console.log(`✅ Available tools count: ${tools.tools.length}`);
  console.log('Sample tools:', tools.tools.map(t => t.name));

  await client.close();
  console.log('--- Local SSE Test Complete ---');
}

testLocalSse().catch(err => {
  console.error('Local SSE Test Error:', err);
  process.exit(1);
});
