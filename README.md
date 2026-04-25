# MCP Translator Proxy

A JSON-RPC to REST API translator that proxies MCP requests from Claude Code to MCPO service. Built for the **OpenClaude ecosystem** to enable seamless integration with remote MCP servers.

## ⚠️ Why This Approach? (Important!)

### The Problem with Stdio

Claude Code (and other MCP clients) expect to communicate with MCP servers via **stdio transport** — they spawn the server as a child process and communicate through stdin/stdout. This works great for local servers, but **fails completely for remote servers** because:

1. **You can't pipe stdin/stdout over a network** — stdio is a local-only transport
2. **No network access** — stdio has no way to connect to remote servers
3. **Firewall/SSH barriers** — even if you tried, network topology blocks it

### The Solution: HTTP Proxy

MCPO exposes MCP functionality via **REST APIs** over HTTP — the standard way to access remote services. mcpo-translator bridges the gap by:

```
Claude Code (MCP stdio)  →  mcpo-translator (HTTP)  →  MCPO REST API  →  MCP Servers
```

This lets Claude Code use remote MCP servers just like local ones, while MCPO handles the actual server communication.

**Key Priority**: This HTTP transport is the primary, supported method for remote MCP servers. Stdio only works for local processes — it's not a limitation of this tool, it's a fundamental constraint of the stdio protocol.

## Features

### ⚡ Spec Caching
- OpenAPI specs cached locally with 24-hour TTL
- Instant startup after first run
- Reduces MCPO server load significantly

### 🔄 Retry Logic
- Exponential backoff for transient failures (500ms → 1s → 2s)
- Automatic retry on connection errors, timeouts, 5xx errors
- Configurable max retries and backoff multiplier

### 🔍 Tool Search & Discovery
- Search across all tools with `searchTools(query)`
- Filter tools by server with `getToolsByServer()`
- List all available servers with `getServers()`

### ✅ Full Protocol Support
- **HTTP Transport**: Standard JSON-RPC over HTTP POST
- **SSE Transport**: Server-Sent Events for streaming
- **WebSocket Transport**: Bidirectional communication
- Automatic tool discovery from OpenAPI specs

### 🔐 Authentication
- Bearer token propagation
- Configurable auth headers
- Secure token handling (in-memory only)

### 📊 Monitoring
- Health check endpoint (`/health`)
- Tool discovery endpoint (`/tools`)
- Structured logging with request/response metrics

## Architecture

```
┌─────────────────┐   MCP JSON-RPC   ┌─────────────────┐   REST API   ┌─────────────────┐
│   Claude Code   │  ──────────────► │ mcpo-translator │ ───────────► │  MCPO Server    │
│  (OpenClaude)   │  ◄────────────── │                 │  ◄────────── │                │
└─────────────────┘                  └─────────────────┘              └─────────────────┘
```

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your MCPO server details
```

### 3. Start Server
```bash
npm start
# Development mode with auto-reload:
npm run dev
```

### 4. Configure Claude Code
Update your `~/.mcp.json`:
```json
{
  "servers": [
    {
      "name": "mcpo-translator",
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  ]
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `MCPO_BASE_URL` | `https://mcpo.example.com` | MCPO server URL |
| `MCPO_AUTH_TOKEN` | - | Bearer token for authentication |
| `LOG_LEVEL` | `info` | Logging level |
| `CACHE_ENABLED` | `true` | Enable spec caching |
| `CACHE_TTL` | `86400000` | Cache TTL (24 hours) |
| `MAX_RETRIES` | `3` | Max retry attempts |
| `RETRY_DELAY_MS` | `500` | Initial retry delay |
| `RETRY_BACKOFF_MULTIPLIER` | `2` | Backoff multiplier |

### MCP Configuration File

The translator also reads from `~/.mcp.json`:
```json
{
  "servers": [],
  "mcpoBaseURL": "https://mcpo.example.com",
  "authToken": "your-token",
  "environment": "development"
}
```

## API Endpoints

### MCP Endpoints
- `POST /mcp` - HTTP JSON-RPC endpoint
- `GET /mcp/sse` - Server-Sent Events endpoint
- `WS /mcp/ws` - WebSocket endpoint

### Management Endpoints
- `GET /health` - Health check
- `GET /tools` - List discovered tools

## MCP Protocol Implementation

The translator implements the following MCP methods:

### `initialize`
Initialize the connection and discover available tools.

### `tools/list`
Return list of available tools parsed from OpenAPI spec.

### `tools/call`
Call a tool by making REST API request to MCPO server.

## Development

### Running Tests
```bash
npm test
```

### Code Structure
```
src/
├── server.js              # HTTP/SSE/WebSocket server
├── mcp-proxy-handler.js   # MCP JSON-RPC handler with retry & caching
├── openapi-parser.js      # OpenAPI to MCP tool converter
└── config.js              # Configuration management
```

### Adding New Tool Support
1. Update tool mapping in `mcp-proxy-handler.js`
2. Add schema parsing logic in `openapi-parser.js`
3. Test with real MCPO endpoints

## Troubleshooting

### Common Issues

1. **Connection refused**
   - Check if translator server is running
   - Verify port configuration

2. **Authentication errors**
   - Ensure `MCPO_AUTH_TOKEN` is set
   - Check token expiration

3. **Tool discovery fails**
   - Verify MCPO server accessibility
   - Check OpenAPI spec format

4. **Claude Code connection fails**
   - Verify `~/.mcp.json` configuration
   - Check transport compatibility

### Enable Debug Logging
```bash
LOG_LEVEL=debug npm start
```

## Performance

- **Spec Caching**: 24-hour TTL for OpenAPI specs
- **Connection Pooling**: HTTP agents reuse connections
- **Retry Logic**: Exponential backoff prevents hammering failing servers

## Security

- Auth tokens stored in memory only (never persisted)
- All inputs validated against schemas
- Configurable CORS policies

## .gitignore

This project includes a `.gitignore` that excludes:
- `node_modules/` - Dependencies
- `.env` - Environment secrets
- `cache/` and `.spec-cache/` - Cached specs
- Logs and OS files
- IDE configurations

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

**Made with ❤️ for the OpenClaude community**