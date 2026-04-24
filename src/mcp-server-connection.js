const { spawn } = require('child_process');
const axios = require('axios');
const EventEmitter = require('events');

/**
 * MCPServerConnection - Handles connection to a single MCP server
 * Supports stdio (child process) and HTTP transports
 * Includes reconnection logic and keep-alive monitoring
 */
class MCPServerConnection extends EventEmitter {
  constructor(serverName, config) {
    super();
    this.serverName = serverName;
    this.config = config;
    this.transport = config.type || 'stdio'; // 'stdio' or 'http'
    this.connected = false;
    this.tools = [];
    this.childProcess = null;
    this.requestCounter = 0;
    this.pendingRequests = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 3;
    this.reconnectDelay = config.reconnectDelay || 5000; // 5 seconds
    this.lastActivity = Date.now();
    this.keepAliveInterval = config.keepAliveInterval || 30000; // 30 seconds
    this.keepAliveTimer = null;
  }

  /**
   * Connect to the MCP server
   */
  async connect() {
    try {
      if (this.transport === 'stdio') {
        await this._connectStdio();
      } else if (this.transport === 'http') {
        await this._connectHTTP();
      } else {
        throw new Error(`Unsupported transport: ${this.transport}`);
      }

      this.connected = true;
      this.reconnectAttempts = 0; // Reset on successful connection
      this.lastActivity = Date.now();
      console.log(`✅ Connected to ${this.serverName} via ${this.transport}`);

      // Start keep-alive monitoring
      this._startKeepAlive();

      // Initialize and get tools
      await this.initialize();
      this.tools = await this.listTools();

      return true;
    } catch (error) {
      console.error(`❌ Failed to connect to ${this.serverName}:`, error.message);
      this.connected = false;
      this._stopKeepAlive();

      // Try reconnection if not exceeded max attempts
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        return this._attemptReconnect();
      }

      return false;
    }
  }

  /**
   * Connect via stdio (spawn child process)
   */
  async _connectStdio() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {} } = this.config;

      // Merge with process env
      const processEnv = { ...process.env, ...env };

      this.childProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: processEnv
      });

      // Handle stdout (JSON-RPC responses)
      this.childProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const response = JSON.parse(line);
            this._handleResponse(response);
          } catch (error) {
            console.error(`Invalid JSON from ${this.serverName}:`, line);
          }
        }
      });

      // Handle stderr
      this.childProcess.stderr.on('data', (data) => {
        console.error(`[${this.serverName} stderr]:`, data.toString());
      });

      // Handle process exit - trigger reconnection
      this.childProcess.on('close', (code) => {
        console.log(`[${this.serverName}] Process exited with code ${code}`);
        this.connected = false;
        this._stopKeepAlive();
        this.emit('disconnected', code);

        // Auto-reconnect if not exceeded max attempts
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          console.log(`🔄 ${this.serverName} crashed, attempting auto-reconnect...`);
          setTimeout(() => {
            this._attemptReconnect().then(reconnected => {
              if (reconnected) {
                console.log(`✅ Auto-reconnect successful for ${this.serverName}`);
                this.emit('reconnected');
              } else {
                console.log(`❌ Auto-reconnect failed for ${this.serverName}`);
                this.emit('reconnection-failed');
              }
            });
          }, 1000);
        }
      });

      // Handle process error
      this.childProcess.on('error', (error) => {
        console.error(`[${this.serverName}] Process error:`, error.message);
        reject(error);
      });

      // Wait a moment for process to start
      setTimeout(resolve, 100);
    });
  }

  /**
   * Connect via HTTP
   */
  async _connectHTTP() {
    // For HTTP transport, just validate the endpoint is reachable
    const { url } = this.config;
    try {
      // Try health check or simple GET
      const healthUrl = url.replace(/\/mcp$/, '/health');
      await axios.get(healthUrl, { timeout: 5000 });
      console.log(`✅ HTTP server ${this.serverName} reachable at ${url}`);
    } catch (error) {
      // If no health endpoint, that's OK - we'll discover during initialize
      console.log(`⚠️  HTTP server ${this.serverName} may not have health endpoint`);
    }
    return true;
  }

  /**
   * Send JSON-RPC request to server
   */
  async sendRequest(method, params = {}) {
    if (!this.connected) {
      throw new Error(`Server ${this.serverName} not connected`);
    }

    const requestId = ++this.requestCounter;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject });

      // Send based on transport
      if (this.transport === 'stdio') {
        this.childProcess.stdin.write(JSON.stringify(request) + '\n');
      } else if (this.transport === 'http') {
        this._sendHTTPRequest(request).then(resolve).catch(reject);
      }
    });
  }

  /**
   * Send request via HTTP transport
   */
  async _sendHTTPRequest(request) {
    const { url, headers = {} } = this.config;

    try {
      const response = await axios.post(url, request, {
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        timeout: 30000
      });

      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        throw new Error(`Network error: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Handle JSON-RPC response from stdio transport
   */
  _handleResponse(response) {
    const { id, result, error } = response;

    if (this.pendingRequests.has(id)) {
      const { resolve, reject } = this.pendingRequests.get(id);

      if (error) {
        reject(new Error(`JSON-RPC error: ${error.message || error}`));
      } else {
        resolve(result);
      }

      this.pendingRequests.delete(id);
    } else {
      console.warn(`[${this.serverName}] Received response for unknown request ID: ${id}`);
    }
  }

  /**
   * Initialize connection with server
   * Send BOTH legacy (clientInfo) AND FastMCP (protocolVersion, capabilities) parameters
   * This ensures compatibility with both protocol standards
   */
  async initialize() {
    const result = await this.sendRequest('initialize', {
      clientInfo: {
        name: 'mcp-translator',
        version: '1.0.0'
      },
      protocolVersion: '1.0',
      capabilities: {
        tools: {},
        resources: {},
        notifications: {}
      }
    });

    this.capabilities = result.capabilities || {};
    this.serverInfo = result.serverInfo || {};

    return result;
  }

  /**
   * List available tools from server
   */
  async listTools() {
    try {
      const result = await this.sendRequest('tools/list');
      const tools = result.tools || [];

      // Prefix tool names with server name to avoid conflicts
      return tools.map(tool => ({
        ...tool,
        name: `${this.serverName}::${tool.name}`,
        originalName: tool.name,
        server: this.serverName
      }));
    } catch (error) {
      console.error(`Failed to get tools from ${this.serverName}:`, error.message);
      return [];
    }
  }

  /**
   * Call a tool on this server
   */
  async callTool(toolName, args) {
    // Remove server prefix if present
    const originalToolName = toolName.replace(`${this.serverName}::`, '');

    try {
      const result = await this.sendRequest('tools/call', {
        name: originalToolName,
        arguments: args
      });

      return result;
    } catch (error) {
      throw new Error(`Tool call ${toolName} failed: ${error.message}`);
    }
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    if (this.transport === 'stdio' && this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }

    this.connected = false;
    this.pendingRequests.clear();
    this._stopKeepAlive();
    console.log(`✅ Disconnected from ${this.serverName}`);
  }

  /**
   * Check if server is still connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get server information
   */
  getInfo() {
    return {
      name: this.serverName,
      transport: this.transport,
      connected: this.connected,
      toolCount: this.tools.length,
      reconnectAttempts: this.reconnectAttempts,
      lastActivity: new Date(this.lastActivity).toISOString(),
      config: this.config
    };
  }

  /**
   * Attempt reconnection with exponential backoff
   */
  async _attemptReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`🔄 Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} to ${this.serverName} in ${delay}ms`);

    return new Promise((resolve) => {
      setTimeout(async () => {
        try {
          const connected = await this.connect();
          resolve(connected);
        } catch (error) {
          console.error(`❌ Reconnection ${this.reconnectAttempts} failed for ${this.serverName}:`, error.message);
          resolve(false);
        }
      }, delay);
    });
  }

  /**
   * Start keep-alive monitoring
   */
  _startKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    this.keepAliveTimer = setInterval(() => {
      const timeSinceLastActivity = Date.now() - this.lastActivity;

      if (timeSinceLastActivity > this.keepAliveInterval) {
        console.log(`⚠️  ${this.serverName} idle for ${timeSinceLastActivity}ms, sending keep-alive ping`);
        this._sendKeepAlive().catch(error => {
          console.error(`❌ Keep-alive failed for ${this.serverName}:`, error.message);
          this.connected = false;
          this.emit('disconnected', 'keep-alive-failed');
        });
      }
    }, this.keepAliveInterval / 2); // Check twice as often as keep-alive interval
  }

  /**
   * Stop keep-alive monitoring
   */
  _stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * Send keep-alive ping (simple tools/list request)
   */
  async _sendKeepAlive() {
    try {
      await this.sendRequest('tools/list', {});
      this.lastActivity = Date.now();
      console.log(`✅ Keep-alive successful for ${this.serverName}`);
    } catch (error) {
      throw new Error(`Keep-alive failed: ${error.message}`);
    }
  }

  /**
   * Update last activity timestamp
   */
  _updateActivity() {
    this.lastActivity = Date.now();
  }

  /**
   * Send request with activity tracking
   */
  async sendRequest(method, params = {}) {
    this._updateActivity();
    return await this._sendRequestInternal(method, params);
  }

  /**
   * Internal send request method (used by sendRequest)
   */
  async _sendRequestInternal(method, params = {}) {
    if (!this.connected) {
      throw new Error(`Server ${this.serverName} not connected`);
    }

    const requestId = ++this.requestCounter;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject });

      // Send based on transport
      if (this.transport === 'stdio') {
        this.childProcess.stdin.write(JSON.stringify(request) + '\n');
      } else if (this.transport === 'http') {
        this._sendHTTPRequest(request).then(resolve).catch(reject);
      }
    });
  }
}

module.exports = MCPServerConnection;