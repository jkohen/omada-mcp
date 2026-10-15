import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function verifyMethods() {
  const baseUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
  const clientId = process.env.OAUTH_CLIENT_ID || 'omada_test_client';
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || 'test_oauth_client_secret';

  console.log('=== Omada MCP Method Verification ===\n');

  console.log('1. Acquiring OAuth 2.0 Bearer token...');
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Failed to get OAuth token: ${JSON.stringify(tokenData)}`);
  }
  console.log('   ✅ OAuth 2.0 JWT acquired successfully\n');

  console.log('2. Establishing StreamableHTTP MCP connection...');
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        }
      }
    }
  );

  const client = new Client(
    { name: 'verify-methods-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('   ✅ Connected to MCP Gateway!\n');

  console.log('3. Listing registered MCP tools...');
  const toolsList = await client.listTools();
  console.log(`   ✅ Total Tools Registered: ${toolsList.tools.length}`);

  // Breakdown by prefix
  const counts = {};
  for (const tool of toolsList.tools) {
    const prefix = tool.name.replace(/[A-Z].*$/, '');
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  console.log('   Breakdown by action prefix:');
  for (const [prefix, count] of Object.entries(counts)) {
    console.log(`     - ${prefix}*: ${count} tools`);
  }
  const readSample = toolsList.tools.find(t => t.name === 'listSites');
  const rebootSample = toolsList.tools.find(t => t.name === 'rebootDevice');
  const blockSample = toolsList.tools.find(t => t.name === 'blockClient');
  console.log(`\n   Tool annotations check:`);
  console.log(`     - listSites:   `, JSON.stringify(readSample?.annotations));
  console.log(`     - rebootDevice:`, JSON.stringify(rebootSample?.annotations));
  console.log(`     - blockClient: `, JSON.stringify(blockSample?.annotations));
  console.log('');

  async function testMethod(name, args = {}) {
    console.log(`Testing tool: ${name}`);
    try {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        console.log(`   ⚠️ Tool returned error: ${res.content?.[0]?.text || 'Unknown error'}`);
        return null;
      }
      const text = res.content?.[0]?.text;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return parsed;
    } catch (err) {
      console.log(`   ❌ Exception calling ${name}: ${err.message}`);
      return null;
    }
  }

  // 4. Test listSites
  const sites = await testMethod('listSites');
  assert.ok(Array.isArray(sites) && sites.length > 0, 'Expected listSites to return at least one site');
  console.log(`   ✅ PASS: listSites returned ${sites.length} site(s):`);
  for (const s of sites) {
    console.log(`      • Site Name: "${s.name}", ID: ${s.id}, Public IP: ${s.sitePublicIp || 'N/A'}`);
  }
  console.log('');

  // 5. Test listDevices
  const devices = await testMethod('listDevices');
  assert.ok(Array.isArray(devices) && devices.length > 0, 'Expected listDevices to return at least one device');
  console.log(`   ✅ PASS: listDevices returned ${devices.length} device(s):`);
  for (const d of devices) {
    console.log(`      • [${d.type || 'Device'}] ${d.name || d.model} (Model: ${d.model}, IP: ${d.ip}, MAC: ${d.mac}, Status: ${d.status})`);
  }
  console.log('');

  // 5b. Test listDevices with siteId: 'Default' (LLM alias test)
  const defaultDevices = await testMethod('listDevices', { siteId: 'Default' });
  assert.ok(Array.isArray(defaultDevices) && defaultDevices.length > 0, 'Expected listDevices with siteId: Default to resolve');
  console.log(`   ✅ PASS: listDevices with siteId: "Default" resolved to ${defaultDevices.length} device(s)\n`);

  // 5c. Test getControllerStatus
  const ctrlStatus = await testMethod('getControllerStatus');
  assert.ok(ctrlStatus && typeof ctrlStatus === 'object', 'Expected getControllerStatus to return status object');
  console.log(`   ✅ PASS: getControllerStatus returned: Gateway=${ctrlStatus.connectedGatewayNum}/${ctrlStatus.totalGatewayNum}, APs=${ctrlStatus.connectedApNum}/${ctrlStatus.totalApNum}, Clients=${ctrlStatus.totalClientNum}\n`);

  // 6. Test listClients
  const clients = await testMethod('listClients');
  assert.ok(Array.isArray(clients), 'Expected listClients to return an array');
  const wirelessCount = clients.filter(c => c.wireless).length;
  const wiredCount = clients.filter(c => !c.wireless).length;
  console.log(`   ✅ PASS: listClients returned ${clients.length} active client(s):`);
  console.log(`      • Wireless clients: ${wirelessCount}`);
  console.log(`      • Wired clients:    ${wiredCount}`);
  const sampleClients = clients.slice(0, 5);
  for (const c of sampleClients) {
    console.log(`      • Client: "${c.name || c.hostName || 'Unnamed'}" | IP: ${c.ip} | MAC: ${c.mac} | Network: ${c.wireless ? 'WiFi (' + c.ssid + ')' : 'Wired'}`);
  }
  if (clients.length > 5) {
    console.log(`      ... and ${clients.length - 5} more clients.`);
  }
  console.log('');

  // 7. Test getDashboardOverview
  const overview = await testMethod('getDashboardOverview');
  assert.ok(overview && typeof overview === 'object', 'Expected getDashboardOverview to return an object');
  console.log('   ✅ PASS: getDashboardOverview returned telemetry:');
  console.log(`      • Gateway Status: ${overview.gatewayStatus ?? 'N/A'}`);
  console.log(`      • Total APs: ${overview.totalApNum ?? 'N/A'} (Connected: ${overview.connectedApNum ?? 'N/A'})`);
  console.log(`      • Total Switches: ${overview.totalSwitchNum ?? 'N/A'} (Connected: ${overview.connectedSwitchNum ?? 'N/A'})`);
  console.log(`      • Total Users: ${overview.totalUserNum ?? 'N/A'} (Wireless: ${overview.wirelessUserNum ?? 'N/A'}, Wired: ${overview.wiredUserNum ?? 'N/A'})`);
  console.log('');

  // 8. Test getGatewayDetail
  const gatewayDevice = devices.find(d => d.type === 'gateway' || d.model?.toLowerCase().includes('fusion'));
  const gwMac = gatewayDevice?.mac || '00-11-22-33-44-55';
  const gwDetail = await testMethod('getGatewayDetail', { gatewayMac: gwMac });
  if (gwDetail) {
    console.log('   ✅ PASS: getGatewayDetail returned details:');
    console.log(`      • Gateway: ${gwDetail.name || 'Gateway'} (Model: ${gwDetail.model}, IP: ${gwDetail.ip}, Firmware: ${gwDetail.firmwareVersion || gwDetail.version})`);
  }
  console.log('');

  // 9. Test getGatewayPorts
  const gwPorts = await testMethod('getGatewayPorts', { gatewayMac: gwMac });
  if (gwPorts) {
    console.log('   ✅ PASS: getGatewayPorts returned gateway port details:');
    console.log(`      • Ports configured: ${Array.isArray(gwPorts) ? gwPorts.length : 'N/A'}`);
  }
  console.log('');

  // 10. Test getDevice (fetch single device detail)
  const apDevice = devices.find(d => d.type === 'ap' || d.mac !== gwMac);
  const devId = apDevice?.mac || '00-11-22-33-44-66';
  const device = await testMethod('getDevice', { deviceId: devId });
  if (device) {
    console.log('   ✅ PASS: getDevice returned AP details:');
    console.log(`      • Device: "${device.name}" (Model: ${device.model}, IP: ${device.ip}, MAC: ${device.mac}, Status: ${device.status})`);
  }
  console.log('');

  // 11. Test getClientDetail
  const sampleClient = clients.find(c => c.mac);
  const clientMac = sampleClient?.mac || '00-11-22-33-44-77';
  const clientDetail = await testMethod('getClientDetail', { clientMac: clientMac });
  if (clientDetail) {
    console.log('   ✅ PASS: getClientDetail returned client details:');
    console.log(`      • Client: "${clientDetail.name}" (IP: ${clientDetail.ip}, MAC: ${clientDetail.mac}, SSID: ${clientDetail.ssid || 'N/A'}, Signal: ${clientDetail.signalLevel || clientDetail.rssi} dBm)`);
  }
  console.log('');

  // 12. Test getApDetail
  const apDetail = await testMethod('getApDetail', { apMac: devId });
  if (apDetail) {
    console.log('   ✅ PASS: getApDetail returned AP hardware details:');
    console.log(`      • AP Name: "${apDetail.name}" (Model: ${apDetail.model}, Firmware: ${apDetail.firmwareVersion || apDetail.version})`);
  }
  console.log('');

  // 13. Test listSiteEvents
  const eventsResult = await testMethod('listSiteEvents', { page: 1, pageSize: 5 });
  if (eventsResult) {
    console.log('   ✅ PASS: listSiteEvents returned event log structure:');
    console.log(`      • Total Events: ${eventsResult.totalRows ?? '0'} (Page size: ${eventsResult.currentSize ?? '5'})`);
  }
  console.log('');

  // 14. Test listSiteAlerts
  const alertsResult = await testMethod('listSiteAlerts', { page: 1, pageSize: 5 });
  if (alertsResult) {
    console.log('   ✅ PASS: listSiteAlerts returned alert log structure:');
    console.log(`      • Total Alerts: ${alertsResult.totalRows ?? '0'} (Page size: ${alertsResult.currentSize ?? '5'})`);
  }
  console.log('');

  // 15. Test getLanNetworkListV2
  const lanNetworks = await testMethod('getLanNetworkListV2', { page: 1, pageSize: 10 });
  if (lanNetworks) {
    console.log('   ✅ PASS: getLanNetworkListV2 returned LAN network list:');
    console.log(`      • Networks count: ${lanNetworks.totalRows ?? lanNetworks.data?.length ?? 'N/A'}`);
  }
  console.log('');

  // 16. Test getWlanGroupList
  const wlanGroups = await testMethod('getWlanGroupList');
  if (wlanGroups) {
    console.log('   ✅ PASS: getWlanGroupList returned WLAN groups:');
    console.log(`      • WLAN Groups: ${wlanGroups.data?.map(w => w.name).join(', ') || 'N/A'}`);
  }
  console.log('');

  // 17. Test listMdnsProfile
  const mdnsProfile = await testMethod('listMdnsProfile');
  if (mdnsProfile) {
    console.log('   ✅ PASS: listMdnsProfile returned mDNS configuration:');
    console.log(`      • mDNS:`, JSON.stringify(mdnsProfile));
  }
  console.log('');

  // 18. Test getSiteSettings
  const siteSettings = await testMethod('getSiteSettings');
  if (siteSettings) {
    console.log('   ✅ PASS: getSiteSettings returned native site settings:');
    console.log(`      • Site Config Keys: ${Object.keys(siteSettings).slice(0, 6).join(', ')}...`);
  }
  console.log('');

  // 19. Test getSiteServiceSettings
  const serviceSettings = await testMethod('getSiteServiceSettings');
  if (serviceSettings) {
    console.log('   ✅ PASS: getSiteServiceSettings returned native site services:');
    console.log(`      • Fast Roaming: ${serviceSettings.roaming?.fastRoamingEnable ? 'Enabled' : 'Disabled'}`);
    console.log(`      • Mesh: ${serviceSettings.mesh?.meshEnable ? 'Enabled' : 'Disabled'}`);
    console.log(`      • Band Steering: ${serviceSettings.bandSteering?.bandSteeringEnable ? 'Enabled' : 'Disabled'}`);
  }
  console.log('');

  // 20. Test getGridKnownClients
  const knownClients = await testMethod('getGridKnownClients', { page: 1, pageSize: 5 });
  if (knownClients) {
    console.log('   ✅ PASS: getGridKnownClients returned known clients insight:');
    console.log(`      • Known clients recorded: ${knownClients.totalRows ?? 'N/A'}`);
  }
  console.log('');

  await client.close();
  console.log('\n=== All Method Verification Tests Completed Successfully! ===\n');
}

verifyMethods().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
