const MCPProxyHandler = require('./src/mcp-proxy-handler');
const fs = require('fs');

async function testSchemaResolution() {
  console.log('Testing deep schema resolution...');
  const handler = new MCPProxyHandler();

  // Load a sample OpenAPI spec to test
  const specExample = {
    openapi: '3.0.0',
    info: { title: 'Test' },
    components: {
      schemas: {
        'FormModel': {
          type: 'object',
          properties: {
            'request': {
              '$ref': '#/components/schemas/RequestModel'
            }
          },
          required: ['request']
        },
        'RequestModel': {
          type: 'object',
          properties: {
            'action': {
              type: 'integer',
              description: 'Action type',
              enum: [1, 2, 3]
            },
            'symbol': {
              type: 'string',
              description: 'Symbol name'
            },
            'nested': {
              '$ref': '#/components/schemas/NestedModel'
            }
          },
          required: ['action', 'symbol']
        },
        'NestedModel': {
          type: 'object',
          properties: {
            'value': {
              type: 'number',
              description: 'Nested value'
            },
            'optional': {
              type: 'string',
              description: 'Optional field'
            }
          },
          required: ['value']
        }
      }
    }
  };

  console.log('\n1. Testing deepResolveSchema method...');
  const resolved = handler._deepResolveSchema({
    '$ref': '#/components/schemas/FormModel'
  }, specExample, new Set());

  console.log('Resolved schema:', JSON.stringify(resolved, null, 2));
  console.log('\n2. Testing _extractToolsFromOpenAPI flow...');

  // Simulate what happens for a real tool
  const spec = {
    summary: 'Test tool',
    description: 'This is a test tool',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/FormModel'
          }
        }
      }
    }
  };

  console.log('\nInput schema extraction test:');
  const inputSchema = handler._extractInputSchema(spec, specExample);
  console.log('Input schema:', JSON.stringify(inputSchema, null, 2));
  console.log('\nProperties count:', Object.keys(inputSchema.properties || {}).length);

  if (Object.keys(inputSchema.properties || {}).length > 0) {
    console.log('✅ SUCCESS: Deep resolution works!');
  } else {
    console.log('❌ FAILED: Empty properties');
  }
}

testSchemaResolution().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});