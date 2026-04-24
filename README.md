# MCP Translator Proxy

A JSON-RPC to REST API translator that proxies MCP requests from Claude Code to MCPO service.

## Architecture

```
Claude Code (JSON-RPC) ↔ MCP Translator ↔ MCPO REST API ↔ Individual MCP Servers
```

## How It Works

The translator acts as a pure proxy between Claude Code (expecting JSON-RPC MCP protocol) and MCPO (exposing REST APIs):

1. **Initialization**: Translator queries MCPO at `http://localhost:8866` for available servers
2. **Discovery**: Checks each server's `/openapi.json` endpoint to discover tools
3. **Tool Extraction**: Parses OpenAPI specs to extract tool definitions
4. **Aggregation**: Collects tools from all servers, renaming conflicts with server prefixes
5. **Proxy**: When Claude Code calls a tool, translator proxies the call to MCPO REST API

**NO LOCAL SERVERS ARE SPAWNED** - Translator is a pure proxy to MCPO REST API.

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
# Development mode:
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

## Architecture

```
┌─────────────────┐    MCP JSON-RPC    ┌─────────────────┐    REST API     ┌─────────────────┐
│   Claude Code   │ ──────────────────►│   Translator    │ ───────────────►│   MCPO Server   │
│                 │ ◄──────────────────│                 │ ◄───────────────│                 │
└─────────────────┘                    └─────────────────┘                 └─────────────────┘
```

## Features

### ✅ Protocol Support
- **HTTP Transport**: Standard JSON-RPC over HTTP POST
- **SSE Transport**: Server-Sent Events for streaming
- **WebSocket Transport**: Bidirectional communication

### ✅ Tool Discovery
- Automatic parsing of OpenAPI specs
- Dynamic tool registration
- Caching for performance

### ✅ Authentication
- Bearer token propagation
- Configurable auth headers
- Token rotation support

### ✅ Monitoring
- Health check endpoint (`/health`)
- Tool discovery endpoint (`/tools`)
- Structured logging
- Request/response metrics

## Configuration

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `MCPO_BASE_URL` | `https://mcpo.gophernuttz.us` | MCPO server URL |
| `MCPO_AUTH_TOKEN` | - | Bearer token for authentication |
| `LOG_LEVEL` | `info` | Logging level |
| `CACHE_ENABLED` | `true` | Enable tool caching |
| `CACHE_TTL` | `60000` | Cache TTL in milliseconds |

### MCP Configuration File
The translator reads from `~/.mcp.json`:
```json
{
  "servers": [],
  "mcpoBaseURL": "https://mcpo.gophernuttz.us",
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

## Tool Discovery Process

1. Fetch OpenAPI spec from `{MCPO_BASE_URL}/{toolname}/openapi.json`
2. Parse paths and schemas
3. Convert to MCP tool definitions
4. Cache results for performance

## Example Tool Mapping

| MCP Tool Name | REST Endpoint | HTTP Method |
|---------------|---------------|-------------|
| `search_notes` | `/search` | POST |
| `read_note` | `/read_note` | POST |
| `edit_note` | `/edit_note` | POST |
| `delete_note` | `/delete_note` | POST |

## Development

### Running Tests
```bash
npm test
```

### Code Structure
```
src/
├── server.js          # HTTP/SSE/WebSocket server
├── mcp-handler.js     # MCP JSON-RPC handler
├── openapi-parser.js  # OpenAPI to MCP tool converter
└── config.js         # Configuration management
```

### Adding New Tool Support
1. Update tool mapping in `mcp-handler.js`
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

### Logs
Enable debug logging:
```bash
LOG_LEVEL=debug npm start
```

## Performance Optimization

- **Caching**: Tool definitions cached for 1 minute
- **Connection pooling**: HTTP clients reuse connections
- **Request batching**: Future enhancement
- **Compression**: Gzip compression for large responses

## Security Considerations

- **Token handling**: Auth tokens stored in memory only
- **Input validation**: All inputs validated against schemas
- **Rate limiting**: Configurable rate limiting
- **CORS**: Configurable CORS policies

## Future Enhancements

- [ ] Support for multiple MCPO servers
- [ ] Tool result caching
- [ ] Webhook notifications
- [ ] Prometheus metrics
- [ ] Docker containerization
- [ ] Kubernetes deployment

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Support

For issues and questions, open a GitHub issue or contact the maintainers.

---

**Made with ❤️ for the Claude Code community**# mcpo-translator
