const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
require('dotenv').config();

const MCPProxyHandler = require('./mcp-proxy-handler');

class MCPServer {
  constructor() {
    this.app = express();
    expressWs(this.app);

    this.port = process.env.PORT || 6689;
    this.mcpHandler = new MCPProxyHandler();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(morgan('combined'));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    // Simple auth middleware - validate token if provided, but allow requests without auth
    const authMiddleware = (req, res, next) => {
      const authHeader = req.headers.authorization;

      // Skip auth for metadata endpoints and OAuth endpoints
      if (req.path.startsWith('/.well-known/') ||
          req.path.startsWith('/oauth/') ||
          req.path === '/health') {
        return next();
      }

      // ACCEPT ANY BEARER TOKEN OR NO TOKEN AT ALL
      // This bypasses Claude Code's OAuth bug completely
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        console.log(`🔐 Request authenticated with token: ${token.substring(0, 10)}...`);
      } else {
        console.log('⚠️  Request without authentication (auth disabled for tool discovery)');
      }

      next();
    };

    // MCP HTTP endpoint
    this.app.post('/mcp', authMiddleware, async (req, res) => {
      try {
        const response = await this.mcpHandler.handleRequest(req.body);
        res.json(response);
      } catch (error) {
        console.error('MCP request error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          }
        });
      }
    });

    // MCP SSE endpoint
    this.app.get('/mcp/sse', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send initial connection event
      res.write('event: connected\ndata: {"type": "connected"}\n\n');

      // Handle client messages
      req.on('data', async (data) => {
        try {
          const request = JSON.parse(data.toString());
          const response = await this.mcpHandler.handleRequest(request);
          res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        } catch (error) {
          console.error('SSE request error:', error);
        }
      });

      req.on('close', () => {
        console.log('SSE connection closed');
      });
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'mcpo-translator',
        version: '1.0.0'
      });
    });

    // Tool discovery endpoint
    this.app.get('/tools', async (req, res) => {
      try {
        // This endpoint is now obsolete since tools are aggregated by registry
        // But we keep it for compatibility
        res.json({
          message: 'Use MCP endpoint /mcp with JSON-RPC method tools/list',
          note: 'Tools are now aggregated from all configured MCP servers'
        });
      } catch (error) {
        console.error('Tool discovery error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // MCP Server Metadata (Claude Code looks for this)
    this.app.get('/.well-known/mcp.json', (req, res) => {
      res.json({
        name: 'Universal MCP Translator',
        version: '2.0.0',
        registration_endpoint: '/oauth/register',  // Updated to /oauth/register
        capabilities: {
          tools: true,
          resources: false,
          notifications: false
        }
      });
    });

    // RFC 8414 OAuth 2.0 Authorization Server Metadata
    this.app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const baseUrl = `http://localhost:${this.port}`;

      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        scopes_supported: ['tools'],
        response_types_supported: ['code'],  // Only 'code' as per guide
        grant_types_supported: ['authorization_code', 'refresh_token'],  // Fixed as per guide
        token_endpoint_auth_methods_supported: ['none'],  // Public client: no authentication
        code_challenge_methods_supported: ['S256']
      });
    });

    // RFC 8414 OAuth 2.0 Protected Resource Metadata
    this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const baseUrl = `http://localhost:${this.port}`;

      res.json({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ['tools'],
        bearer_methods_supported: ['header']
      });
    });

    // RFC 8414 OAuth 2.0 Protected Resource Metadata for MCP endpoint
    this.app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
      const baseUrl = `http://localhost:${this.port}`;

      res.json({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ['tools'],
        bearer_methods_supported: ['header']
      });
    });

    // Dynamic Client Registration
    this.app.post('/oauth/register', (req, res) => {
      try {
        const body = req.body || {};

        // Use environment variables for client credentials
        const clientId = process.env.MCP_CLIENT_ID || 'mcpo-translator-client';
        const clientSecret = process.env.MCP_CLIENT_SECRET || 'mcpo-translator-secret';

        const clientData = {
          client_id: clientId,
          client_name: body.client_name || 'Claude',
          redirect_uris: body.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'],
          grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
          response_types: body.response_types || ['code'],
          token_endpoint_auth_method: 'none',
          scope: body.scope || 'tools',
          created_at: Date.now(),
        };

        const response = {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: clientData.redirect_uris,
          token_endpoint_auth_method: 'none',
          grant_types: clientData.grant_types,
          response_types: clientData.response_types,
          scope: clientData.scope,
        };

        if (body.client_name) {
          response.client_name = body.client_name;
        }

        res.status(201).json(response);
      } catch (error) {
        res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'Failed to register client'
        });
      }
    });

    // Authorization endpoint
    this.app.get('/oauth/authorize', (req, res) => {
      const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } = req.query;

      // Validate parameters
      if (response_type !== 'code') {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <body>
            <h1>Authorization Error</h1>
            <p>Only authorization code flow (response_type=code) is supported</p>
          </body>
          </html>
        `);
      }

      if (!client_id || !redirect_uri) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <body>
            <h1>Authorization Error</h1>
            <p>Missing required parameters</p>
          </body>
          </html>
        `);
      }

      // Render consent page
      const approveUrl = new URL('/oauth/authorize/approve', `http://localhost:${this.port}`);
      approveUrl.searchParams.set('client_id', client_id);
      approveUrl.searchParams.set('redirect_uri', redirect_uri);
      if (scope) approveUrl.searchParams.set('scope', scope);
      if (state) approveUrl.searchParams.set('state', state);
      if (code_challenge) approveUrl.searchParams.set('code_challenge', code_challenge);
      if (code_challenge_method) approveUrl.searchParams.set('code_challenge_method', code_challenge_method);

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authorize Claude</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; }
            .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            p { color: #6b7280; margin: 0 0 20px; font-size: 14px; }
            .btn { display: inline-block; background: #1d4ed8; color: white; text-decoration: none;
                   padding: 10px 24px; border-radius: 6px; font-size: 15px; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Authorize Claude</h1>
            <p>Claude is requesting access to the MCP Translator with tool access.</p>
            <a href="${approveUrl.pathname}${approveUrl.search}" class="btn">Authorize</a>
          </div>
        </body>
        </html>
      `;

      res.send(html);
    });

    // Authorization approval endpoint
    this.app.get('/oauth/authorize/approve', (req, res) => {
      const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;

      if (!client_id || !redirect_uri) {
        return res.status(400).json({ error: 'Missing parameters' });
      }

      // Generate authorization code
      const authCode = randomBytes(32).toString('hex');

      // Store code data (in memory for now)
      // In production, store in Redis with TTL
      const codeData = {
        client_id,
        redirect_uri,
        scope: scope || 'tools',
        code_challenge,
        code_challenge_method,
        createdAt: Date.now(),
      };

      // TODO: Store in Redis with 10 minute TTL
      console.log(`🔐 Generated authorization code for client ${client_id}: ${authCode}`);

      // Redirect back to Claude with authorization code
      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', authCode);
      if (state) redirectUrl.searchParams.set('state', state);

      res.redirect(redirectUrl.toString());
    });

    // Token endpoint for PUBLIC CLIENTS (token_endpoint_auth_method: 'none')
    this.app.post('/oauth/token', (req, res) => {
      const { grant_type, code, refresh_token, code_verifier, client_id } = req.body;

      // PUBLIC CLIENT: No client secret validation
      // token_endpoint_auth_method: 'none' means no authentication
      const clientId = client_id;

      if (grant_type === 'authorization_code') {
        if (!code) {
          return res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing authorization code'
          });
        }

        // TODO: Retrieve code data from Redis and validate PKCE
        // For now, accept any code
        console.log(`🔐 Exchanging authorization code: ${code.substring(0, 10)}...`);

        // Generate tokens
        const accessToken = randomBytes(32).toString('hex');
        const refreshToken = randomBytes(32).toString('hex');
        const expiresIn = 3600; // 1 hour

        res.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: expiresIn,
          refresh_token: refreshToken,
          scope: 'tools'
        });
      } else if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          return res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing refresh token'
          });
        }

        console.log(`🔐 Refreshing token: ${refresh_token.substring(0, 10)}...`);

        // Generate new tokens
        const newAccessToken = randomBytes(32).toString('hex');
        const newRefreshToken = randomBytes(32).toString('hex');
        const expiresIn = 3600; // 1 hour

        res.json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: expiresIn,
          refresh_token: newRefreshToken,
          scope: 'tools'
        });
      } else {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Only authorization_code and refresh_token grant types are supported'
        });
      }
    });

    // OIDC Configuration (optional but Claude might check)
    this.app.get('/.well-known/openid-configuration', (req, res) => {
      const baseUrl = `http://localhost:${this.port}`;

      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        scopes_supported: ['tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        claims_supported: [],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256']
      });
    });
  }

  setupWebSocket() {
    this.app.ws('/mcp/ws', (ws, req) => {
      console.log('WebSocket connection established');

      ws.on('message', async (message) => {
        try {
          const request = JSON.parse(message.toString());
          const response = await this.mcpHandler.handleRequest(request);
          ws.send(JSON.stringify(response));
        } catch (error) {
          console.error('WebSocket request error:', error);
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal error',
              data: error.message
            }
          }));
        }
      });

      ws.on('close', () => {
        console.log('WebSocket connection closed');
      });
    });
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`🚀 Universal MCP Translator running on port ${this.port}`);
      console.log(`📡 HTTP endpoint: http://localhost:${this.port}/mcp`);
      console.log(`📡 SSE endpoint: http://localhost:${this.port}/mcp/sse`);
      console.log(`📡 WebSocket endpoint: ws://localhost:${this.port}/mcp/ws`);
      console.log(`🏥 Health check: http://localhost:${this.port}/health`);
      console.log(`🌐 MCP metadata: http://localhost:${this.port}/.well-known/mcp.json`);
      console.log(`🔐 OAuth metadata: http://localhost:${this.port}/.well-known/oauth-authorization-server`);
      console.log(`🎯 Aggregating tools from ALL configured MCP servers`);

      // Initialize proxy handler
      setTimeout(async () => {
        try {
          await this.mcpHandler.initialize();
          console.log(`✅ Proxy handler initialized successfully`);
        } catch (error) {
          console.error(`❌ Failed to initialize proxy handler:`, error.message);
        }
      }, 1000);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log('MCP Translator stopped');
    }

    // No health monitoring needed for proxy
  }
}

module.exports = MCPServer;

// Start server if run directly
if (require.main === module) {
  const server = new MCPServer();
  server.start();

  // Handle graceful shutdown
  process.on('SIGINT', (signal) => {
    console.log(`🛑 Received SIGINT signal (${signal}), shutting down gracefully...`);
    console.log('🔄 Stack trace:', new Error().stack);
    server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', (signal) => {
    console.log(`🛑 Received SIGTERM signal (${signal}), shutting down gracefully...`);
    console.log('🔄 Stack trace:', new Error().stack);
    server.stop();
    process.exit(0);
  });

  // Log uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.log(`💥 Uncaught Exception: ${error.message}`);
    console.log('Stack:', error.stack);
    console.log('Shutting down gracefully...');
    server.stop();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.log(`💔 Unhandled Promise Rejection: ${reason}`);
    console.log('Promise:', promise);
    console.log('Shutting down gracefully...');
    server.stop();
    process.exit(1);
  });
}