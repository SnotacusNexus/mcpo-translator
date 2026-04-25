const fs = require('fs');
const path = require('path');

class Config {
  constructor() {
    this.config = this.loadConfig();
    this.env = process.env;
  }

  loadConfig() {
    const configPaths = [
      path.join(process.env.HOME || process.env.USERPROFILE, '.mcp.json'),
      path.join(process.cwd(), '.mcp.json'),
      path.join(__dirname, '..', 'config', 'mcp.json')
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const configData = fs.readFileSync(configPath, 'utf8');
          return JSON.parse(configData);
        }
      } catch (error) {
        console.warn(`Failed to load config from ${configPath}:`, error.message);
      }
    }

    // Default config if no file found
    return {
      servers: [],
      environment: 'development'
    };
  }

  getMCPOBaseURL() {
    // Priority: 1. Environment variable, 2. Config file, 3. Default
    return this.env.MCPO_BASE_URL || 
           this.config.mcpoBaseURL || 
           'https://mcpo.example.com';
  }

  getAuthToken() {
    // Priority: 1. Environment variable, 2. Config file
    return this.env.MCPO_AUTH_TOKEN || 
           this.config.authToken || 
           null;
  }

  getServerInfo() {
    const baseURL = this.getMCPOBaseURL();
    const toolName = this.getToolName();
    
    return {
      name: 'MCPO Translator',
      version: '1.0.0',
      baseURL,
      toolName,
      capabilities: ['tools', 'http-transport', 'sse-transport', 'websocket-transport']
    };
  }

  getToolName() {
    // Extract tool name from base URL or config
    const baseURL = this.getMCPOBaseURL();
    const match = baseURL.match(/https?:\/\/[^\/]+\/([^\/]+)/);
    return match ? match[1] : 'basic-memory';
  }

  getPort() {
    return this.env.PORT || this.config.port || 3000;
  }

  getLogLevel() {
    return this.env.LOG_LEVEL || this.config.logLevel || 'info';
  }

  getCacheConfig() {
    return {
      enabled: this.env.CACHE_ENABLED !== 'false',
      ttl: parseInt(this.env.CACHE_TTL || '60000', 10),
      maxSize: parseInt(this.env.CACHE_MAX_SIZE || '100', 10)
    };
  }

  getRateLimitConfig() {
    return {
      enabled: this.env.RATE_LIMIT_ENABLED !== 'false',
      windowMs: parseInt(this.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      max: parseInt(this.env.RATE_LIMIT_MAX || '100', 10)
    };
  }

  isDevelopment() {
    return this.env.NODE_ENV === 'development' || 
           this.config.environment === 'development';
  }

  isProduction() {
    return this.env.NODE_ENV === 'production' || 
           this.config.environment === 'production';
  }

  // Get MCP server configuration for Claude Code
  getMCPServerConfig() {
    return {
      transport: 'http', // or 'sse' or 'websocket'
      url: `http://localhost:${this.getPort()}/mcp`,
      headers: this.authToken ? {
        'Authorization': `Bearer ${this.getAuthToken()}`
      } : {},
      capabilities: {
        tools: {},
        resources: {},
        notifications: {}
      }
    };
  }

  // Update config at runtime
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    // Save to file if path exists
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE, '.mcp.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log(`Config saved to ${configPath}`);
    } catch (error) {
      console.warn(`Failed to save config: ${error.message}`);
    }
  }

  // Validate configuration
  validate() {
    const errors = [];
    
    if (!this.getMCPOBaseURL()) {
      errors.push('MCPO_BASE_URL is required');
    }
    
    if (!this.getAuthToken()) {
      console.warn('Warning: No auth token configured. Some tools may require authentication.');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = Config;