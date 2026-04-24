#!/usr/bin/env node

const axios = require('axios');

/**
 * Test client for MCP Translator
 * Sends MCP JSON-RPC requests and displays responses
 */

async function testMCPTranslator() {
  const baseURL = 'http://localhost:6689';
  
  console.log('🚀 Testing MCP Translator...\n');
  
  try {
    // 1. Health check
    console.log('📡 Testing health endpoint...');
    const healthResponse = await axios.get(`${baseURL}/health`);
    console.log('✅ Health check:', healthResponse.data);
    console.log();
    
    // 2. Initialize request
    console.log('🔧 Testing initialize...');
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    };

    const initResponse = await axios.post(`${baseURL}/mcp`, initializeRequest);
    console.log('✅ Initialize response:');
    console.log('   Server:', initResponse.data.result?.serverInfo?.name || 'Unknown');
    console.log('   Version:', initResponse.data.result?.serverInfo?.version || 'Unknown');
    console.log('   Aggregated servers:', initResponse.data.result?.serverInfo?.aggregatedServers || '?');
    console.log('   Total tools:', initResponse.data.result?.serverInfo?.totalTools || '?');
    console.log();
    
    // 3. List tools
    console.log('🛠️  Testing tools/list...');
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    };
    
    const toolsResponse = await axios.post(`${baseURL}/mcp`, toolsRequest);
    const tools = toolsResponse.data.result?.tools || [];
    console.log(`✅ Found ${tools.length} aggregated tools:`);

    // Group by server
    const toolsByServer = {};
    tools.forEach(tool => {
      const server = tool.server || 'unknown';
      if (!toolsByServer[server]) toolsByServer[server] = [];
      toolsByServer[server].push(tool);
    });

    // Display grouped
    Object.entries(toolsByServer).forEach(([server, serverTools]) => {
      console.log(`  📦 ${server} (${serverTools.length} tools):`);
      serverTools.slice(0, 3).forEach((tool, i) => {
        console.log(`    - ${tool.name}`);
      });
      if (serverTools.length > 3) {
        console.log(`    ... and ${serverTools.length - 3} more`);
      }
    });
    console.log();
    
    // 4. Test tool call (if tools available)
    if (tools.length > 0) {
      // Find a simple tool to test (prefer non-auth tools)
      const simpleTools = tools.filter(tool => {
        const name = tool.name.toLowerCase();
        // Avoid tools that likely need auth or complex params
        return !name.includes('github') &&
               !name.includes('delete') &&
               !name.includes('write') &&
               !name.includes('create');
      });

      if (simpleTools.length > 0) {
        const testTool = simpleTools[0];
        console.log(`🔍 Testing tool call: ${testTool.name} (from ${testTool.server || 'unknown'})...`);

        const toolCallRequest = {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: testTool.name,
            arguments: {}
          }
        };

        // Add minimal required parameters based on tool schema
        if (testTool.name.includes('search')) {
          toolCallRequest.params.arguments = { query: 'test' };
        } else if (testTool.name.includes('list') || testTool.name.includes('get')) {
          // Empty params for list/get tools
          toolCallRequest.params.arguments = {};
        } else {
          // Generic test
          toolCallRequest.params.arguments = { test: true };
        }

        try {
          const toolCallResponse = await axios.post(`${baseURL}/mcp`, toolCallRequest);
          console.log(`✅ Tool call response for ${testTool.name}:`);
          const result = toolCallResponse.data.result;
          if (result?.content?.[0]?.text) {
            const text = result.content[0].text;
            try {
              const parsed = JSON.parse(text);
              console.log(JSON.stringify(parsed, null, 2).slice(0, 500) + '...');
            } catch {
              console.log(text.slice(0, 500) + '...');
            }
          } else {
            console.log(JSON.stringify(result, null, 2).slice(0, 500) + '...');
          }
        } catch (toolError) {
          console.log(`⚠️  Tool call error: ${toolError.message}`);
          if (toolError.response?.data?.error) {
            console.log(`   Error details: ${JSON.stringify(toolError.response.data.error)}`);
          }
        }
      } else {
        console.log('⚠️  No simple tools found to test');
      }
    }
    
    console.log('\n🎉 All tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  // Check if server is running
  axios.get('http://localhost:6689/health')
    .then(() => testMCPTranslator())
    .catch(err => {
      console.error('❌ MCP Translator server not running on port 3000');
      console.error('Start the server first: npm start');
      process.exit(1);
    });
}

module.exports = { testMCPTranslator };