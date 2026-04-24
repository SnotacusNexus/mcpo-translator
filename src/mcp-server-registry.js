const MCPServerConnection = require('./mcp-server-connection');
const Config = require('./config');

/**
 * MCPServerRegistry - Manages connections to multiple MCP servers
 * Reads .mcp.json configuration and aggregates tools from all servers
 */
class MCPServerRegistry {
  constructor() {
    this.config = new Config();
    this.servers = new Map(); // serverName -> MCPServerConnection
    this.allTools = []; // Aggregated tools from all servers
    this.toolServerMap = new Map(); // toolName -> serverName
    this.initialized = false;
    this.healthMonitor = null;
  }

  /**
   * Initialize registry - connect to all configured servers
   */
  async initialize() {
    if (this.initialized) {
      return this.allTools;
    }

    console.log('🚀 Initializing MCP Server Registry...');

    // Load configuration
    const mcpConfig = this.config.loadConfig();
    const serverConfigs = mcpConfig.mcpServers || {};

    console.log(`📡 Found ${Object.keys(serverConfigs).length} server configurations`);

    // Connect to all enabled servers
    const connectionPromises = [];

    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
      // Skip disabled servers
      if (serverConfig.disabled === true) {
        console.log(`⏸️  Skipping disabled server: ${serverName}`);
        continue;
      }

      // Skip the translator itself (it's the server we're running)
      if (serverName === 'mcpo-translator') {
        continue;
      }

      const connection = new MCPServerConnection(serverName, serverConfig);
      this.servers.set(serverName, connection);

      connectionPromises.push(
        connection.connect()
          .then(connected => {
            if (!connected) {
              console.error(`❌ Failed to connect to ${serverName}, removing from registry`);
              this.servers.delete(serverName);
              return null;
            }
            return connection;
          })
          .catch(error => {
            console.error(`❌ Error connecting to ${serverName}:`, error.message);
            this.servers.delete(serverName);
            return null;
          })
      );
    }

    // Wait for all connections
    const connections = await Promise.all(connectionPromises);
    const successfulConnections = connections.filter(c => c !== null);

    console.log(`✅ Connected to ${successfulConnections.length}/${this.servers.size} servers`);

    // Aggregate tools from all servers
    await this._aggregateTools();

    this.initialized = true;
    return this.allTools;
  }

  /**
   * Aggregate tools from all connected servers
   */
  async _aggregateTools() {
    this.allTools = [];
    this.toolServerMap.clear();

    for (const [serverName, connection] of this.servers.entries()) {
      if (!connection.isConnected()) {
        continue;
      }

      const serverTools = connection.tools || [];

      for (const tool of serverTools) {
        // Check for name conflicts
        const existingToolIndex = this.allTools.findIndex(t => t.name === tool.name);

        if (existingToolIndex !== -1) {
          // Conflict detected - rename with server prefix
          const existingTool = this.allTools[existingToolIndex];
          console.warn(`⚠️  Tool name conflict: ${tool.name} exists in ${existingTool.server} and ${serverName}`);

          // Rename existing tool
          this.allTools[existingToolIndex].name = `${existingTool.server}::${existingTool.originalName}`;
          this.allTools[existingToolIndex].description = `[${existingTool.server}] ${existingTool.description}`;

          // Update tool-server mapping
          this.toolServerMap.set(
            `${existingTool.server}::${existingTool.originalName}`,
            existingTool.server
          );
        }

        // Add the tool
        this.allTools.push(tool);
        this.toolServerMap.set(tool.name, serverName);
      }

      console.log(`📦 ${serverName}: ${serverTools.length} tools`);
    }

    console.log(`🎯 Total aggregated tools: ${this.allTools.length}`);
  }

  /**
   * Get all aggregated tools
   */
  getTools() {
    if (!this.initialized) {
      throw new Error('Registry not initialized. Call initialize() first.');
    }
    return this.allTools;
  }

  /**
   * Call a tool on the appropriate server
   */
  async callTool(toolName, args) {
    if (!this.initialized) {
      throw new Error('Registry not initialized');
    }

    // Find which server handles this tool
    const serverName = this.toolServerMap.get(toolName);

    if (!serverName) {
      throw new Error(`Tool ${toolName} not found in any server`);
    }

    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`Server ${serverName} not found`);
    }

    if (!connection.isConnected()) {
      throw new Error(`Server ${serverName} is not connected`);
    }

    // Call the tool
    return await connection.callTool(toolName, args);
  }

  /**
   * Get server information for diagnostics
   */
  getServerInfo() {
    const serverInfo = [];

    for (const [serverName, connection] of this.servers.entries()) {
      serverInfo.push({
        name: serverName,
        ...connection.getInfo()
      });
    }

    return serverInfo;
  }

  /**
   * Get registry status
   */
  getStatus() {
    const connectedServers = Array.from(this.servers.values()).filter(c => c.isConnected());

    return {
      initialized: this.initialized,
      totalServers: this.servers.size,
      connectedServers: connectedServers.length,
      totalTools: this.allTools.length,
      servers: this.getServerInfo()
    };
  }

  /**
   * Shutdown all connections
   */
  async shutdown() {
    console.log('🔴 Shutting down MCP Server Registry...');

    for (const [serverName, connection] of this.servers.entries()) {
      try {
        connection.disconnect();
        console.log(`✅ Disconnected from ${serverName}`);
      } catch (error) {
        console.error(`❌ Error disconnecting from ${serverName}:`, error.message);
      }
    }

    this.servers.clear();
    this.allTools = [];
    this.toolServerMap.clear();
    this.initialized = false;

    console.log('✅ Registry shutdown complete');
  }

  /**
   * Reconnect to all servers (useful for recovery)
   */
  async reconnect() {
    console.log('🔄 Reconnecting to all servers...');

    await this.shutdown();
    await this.initialize();

    return this.getStatus();
  }

  /**
   * Gracefully degrade - continue working with available servers
   */
  getAvailableTools() {
    const availableTools = [];

    for (const [serverName, connection] of this.servers.entries()) {
      if (connection.isConnected()) {
        const serverTools = connection.tools || [];
        availableTools.push(...serverTools);
      }
    }

    console.log(`🎯 ${availableTools.length} tools available (${this.allTools.length} total configured)`);
    return availableTools;
  }

  /**
   * Monitor server health and auto-reconnect
   */
  async startHealthMonitor(interval = 60000) { // 1 minute
    console.log(`🏥 Starting health monitor for ${this.servers.size} servers (interval: ${interval}ms)`);

    this.healthMonitor = setInterval(async () => {
      const status = this.getStatus();
      const disconnected = status.totalServers - status.connectedServers;

      if (disconnected > 0) {
        console.log(`⚠️  ${disconnected}/${status.totalServers} servers disconnected, attempting reconnection...`);
        await this.reconnect();
      }
    }, interval);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitor() {
    if (this.healthMonitor) {
      clearInterval(this.healthMonitor);
      this.healthMonitor = null;
      console.log('🛑 Health monitor stopped');
    }
  }

  /**
   * Find tools by name pattern
   */
  findTools(pattern) {
    if (!this.initialized) {
      return [];
    }

    const regex = new RegExp(pattern, 'i');
    return this.allTools.filter(tool =>
      regex.test(tool.name) ||
      regex.test(tool.description) ||
      regex.test(tool.server)
    );
  }

  /**
   * Get tools from specific server
   */
  getToolsByServer(serverName) {
    if (!this.initialized) {
      return [];
    }

    return this.allTools.filter(tool => tool.server === serverName);
  }
}

module.exports = MCPServerRegistry;