const MCPServerRegistry = require('./mcp-server-registry');
const Cache = require('./cache');

class MCPHandler {
  constructor() {
    this.registry = new MCPServerRegistry();
    this.config = new (require('./config'))();
    const cacheConfig = this.config.getCacheConfig();
    this.cache = new Cache({
      ttl: cacheConfig.ttl,
      maxSize: cacheConfig.maxSize
    });
    this.tools = null;
    this.initialized = false;
    this.subscribers = new Set(); // For notifications
  }

  async handleRequest(request) {
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      return this.createErrorResponse(request.id, -32600, 'Invalid Request');
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          return await this.handleInitialize(id, params);
        case 'tools/list':
          return await this.handleToolsList(id);
        case 'tools/call':
          return await this.handleToolCall(id, params);
        case 'notifications/list':
          return this.createResponse(id, { notifications: [] });
        case 'resources/list':
          return this.createResponse(id, { resources: [] });
        default:
          return this.createErrorResponse(id, -32601, 'Method not found');
      }
    } catch (error) {
      console.error(`Error handling ${method}:`, error);
      return this.createErrorResponse(id, -32603, 'Internal error', error.message);
    }
  }

  async handleInitialize(id, params) {
    if (this.initialized) {
      return this.createErrorResponse(id, -32600, 'Already initialized');
    }

    const { clientInfo = {} } = params || {};

    // Initialize registry and connect to ALL configured servers
    console.log('🚀 Initializing MCP Registry with all servers...');
    this.tools = await this.registry.initialize();

    this.initialized = true;

    const status = this.registry.getStatus();

    return this.createResponse(id, {
      serverInfo: {
        name: 'Universal MCP Translator',
        version: '2.0.0',
        aggregatedServers: status.connectedServers,
        totalTools: status.totalTools
      },
      capabilities: {
        tools: {},
        resources: {},
        notifications: {}
      },
      instructions: `Universal MCP translator aggregating ${status.connectedServers} servers with ${status.totalTools} tools`
    });
  }

  async handleToolsList(id) {
    if (!this.initialized) {
      return this.createErrorResponse(id, -32000, 'Not initialized');
    }

    return this.createResponse(id, {
      tools: this.tools
    });
  }

  async handleToolCall(id, params) {
    if (!this.initialized) {
      return this.createErrorResponse(id, -32000, 'Not initialized');
    }

    const { name, arguments: args } = params;

    // Find the tool definition
    const tool = this.tools.find(t => t.name === name);
    if (!tool) {
      return this.createErrorResponse(id, -32602, `Tool ${name} not found in aggregated tool list`);
    }

    try {
      // Check cache first
      const cacheKey = Cache.generateKey(name, args);
      const cachedResult = this.cache.get(cacheKey);

      if (cachedResult) {
        console.log(`Cache hit for ${name}`);
        this._notifySubscribers('tool_result', {
          tool: name,
          cacheHit: true,
          timestamp: new Date().toISOString()
        });

        return this.createResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(cachedResult, null, 2)
            }
          ]
        });
      }

      // Cache miss - call tool via registry (which routes to appropriate server)
      console.log(`Cache miss for ${name}, routing via registry`);
      const result = await this.registry.callTool(name, args);

      // Cache successful result
      this.cache.set(cacheKey, result);

      // Notify subscribers
      this._notifySubscribers('tool_result', {
        tool: name,
        cacheHit: false,
        timestamp: new Date().toISOString()
      });

      return this.createResponse(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    } catch (error) {
      console.error(`Tool call ${name} failed:`, error);

      // Notify subscribers of error
      this._notifySubscribers('tool_error', {
        tool: name,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      return this.createErrorResponse(id, -32603, 'Tool call failed', error.message);
    }
  }

  // Tool calls are now handled by registry.callTool() method

  createResponse(id, result) {
    return {
      jsonrpc: '2.0',
      id,
      result
    };
  }

  createErrorResponse(id, code, message, data = null) {
    const error = { code, message };
    if (data) error.data = data;

    return {
      jsonrpc: '2.0',
      id,
      error
    };
  }

  _notifySubscribers(eventType, data) {
    // Log notification for now
    console.log(`Notification: ${eventType}`, data);

    // Broadcast to all subscribers
    for (const subscriber of this.subscribers) {
      try {
        // In a real implementation, this would send via WebSocket/SSE
        // For now, just log that we would notify
        console.log(`Would notify subscriber about ${eventType}`);
      } catch (error) {
        console.error('Failed to notify subscriber:', error);
      }
    }
  }
}

module.exports = MCPHandler;