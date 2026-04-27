const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Config = require('./config');

const SPEC_CACHE_DIR = path.join(process.env.HOME || '/home/snotacus', '.mcpo-translator', 'spec-cache');

/**
 * MCPProxyHandler - Translates JSON-RPC MCP requests to MCPO REST API calls
 * Serves as a proxy between Claude Code (JSON-RPC) and MCPO (REST API)
 *
 * Key features:
 * - Deep recursive $ref resolution with caching
 * - Rich tool descriptions from OpenAPI specs
 * - MCP tool annotations inferred from operation semantics
 * - Background initialization (non-blocking)
 * - Bulletproof error handling (never hangs, never throws to caller)
 * - Spec caching for instant startup
 * - Retry logic with exponential backoff
 * - Tool search/discovery capability
 */
class MCPProxyHandler {
  constructor() {
    this.config = new Config();
    this.mcpoBaseUrl = this.config.getMCPOBaseURL();
    this.authToken = this.config.getAuthToken();
    this.servers = new Map(); // serverName -> { name, tools, openapiSpec }
    this.tools = []; // Aggregated tools from all servers
    this.toolServerMap = new Map(); // toolName -> serverName
    this.initialized = false;
    this._initPromise = null; // Background init promise guard
    this._schemaCache = new Map(); // Cache for resolved schemas

    // Retry configuration
    this.maxRetries = 2;
    this.retryDelayMs = 300;
    this.retryBackoffMultiplier = 2;

    // Discovery timeout - how long to wait for MCPO server discovery
    // before serving with whatever we have. OpenClaude has its own
    // timeout and will show the server as "not connected" if we take
    // too long to respond to tools/list.
    this.discoveryTimeoutMs = 6000;

    // Tool usage metrics
    this._toolMetrics = new Map(); // toolName -> { calls, errors, totalLatency }

    // Ensure cache directory exists
    this._ensureCacheDir();
  }

  // =========================================================================
  // RETRY LOGIC
  // =========================================================================

  /**
   * Execute an async function with exponential backoff retry
   * @param {Function} fn - Async function to execute
   * @param {string} operationName - Name for logging
   * @param {number} maxRetries - Max retry attempts (default: this.maxRetries)
   * @returns {Promise<any>} - Result of the function
   */
  async _executeWithRetry(fn, operationName, maxRetries = this.maxRetries) {
    let lastError;
    const attemptLog = (attempt, delay) => {
      console.log(` ⏳ ${operationName}: attempt ${attempt}/${maxRetries}${delay ? `, retrying in ${delay}ms...` : ''}`);
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const isRetryable = this._isRetryableError(error);

        // Don't retry if error is not retryable and this isn't the last attempt
        if (!isRetryable && attempt < maxRetries) {
          console.error(` ⚠️ ${operationName}: non-retryable error (${error.code || error.message}), giving up`);
          throw error;
        }

        if (attempt < maxRetries) {
          const delay = this.retryDelayMs * Math.pow(this.retryBackoffMultiplier, attempt - 1);
          attemptLog(attempt, delay);
          await this._sleep(delay);
        } else {
          attemptLog(attempt, 0);
        }
      }
    }

    // All retries exhausted
    throw lastError;
  }

  /**
   * Check if an error is retryable (transient failures)
   */
  _isRetryableError(error) {
    if (!error) return false;
    const code = error.code;
    const status = error.response?.status;

    // Retry on network errors
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' ||
      code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return true;
    }

    // Retry on HTTP 5xx errors and rate limiting
    if (status >= 500 || status === 429) {
      return true;
    }

    return false;
  }

  /**
   * Sleep for specified milliseconds
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  // =========================================================================
  // SPEC CACHING
  // =========================================================================

  _ensureCacheDir() {
    if (!fs.existsSync(SPEC_CACHE_DIR)) {
      fs.mkdirSync(SPEC_CACHE_DIR, { recursive: true });
    }
  }

  _getCachePath(serverName) {
    return path.join(SPEC_CACHE_DIR, `${serverName}.json`);
  }

  _loadCachedSpec(serverName) {
    try {
      const cachePath = this._getCachePath(serverName);
      if (fs.existsSync(cachePath)) {
        const stats = fs.statSync(cachePath);
        const age = Date.now() - stats.mtimeMs;
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        if (age < maxAge) {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          console.log(`[CACHE] Loaded cached spec for "${serverName}" (age: ${Math.round(age / 1000)}s)`);
          return cached;
        }
      }
    } catch (err) {
      console.warn(`[CACHE] Failed to load cache for "${serverName}": ${err.message}`);
    }
    return null;
  }

  _saveCachedSpec(serverName, spec) {
    try {
      const cachePath = this._getCachePath(serverName);
      fs.writeFileSync(cachePath, JSON.stringify(spec, null, 2));
      console.log(`[CACHE] Saved spec for "${serverName}" to cache`);
    } catch (err) {
      console.warn(`[CACHE] Failed to cache spec for "${serverName}": ${err.message}`);
    }
  }

  clearCache() {
    try {
      const files = fs.readdirSync(SPEC_CACHE_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(SPEC_CACHE_DIR, file));
      }
      console.log('[CACHE] Cleared all cached specs');
      return true;
    } catch (err) {
      console.error('[CACHE] Failed to clear cache:', err.message);
      return false;
    }
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  /**
   * Initialize by discovering all MCP servers from MCPO
   */
  async initialize() {
    if (this.initialized) {
      return this.tools;
    }

    console.log('Initializing MCP Proxy Handler...');
    console.log(`Connecting to MCPO at ${this.mcpoBaseUrl}`);

    // Try to get server list from MCPO
    await this._discoverServers();

    // Aggregate tools from all discovered servers
    await this._aggregateTools();

    this.initialized = true;
    console.log(`Initialized with ${this.servers.size} servers and ${this.tools.length} tools`);
    return this.tools;
  }

  /**
   * Start background initialization (MCPO discovery)
   * Multiple calls are safe - they all await the same promise
   */
  _startBackgroundInit() {
    if (!this._initPromise) {
      this._initPromise = this.initialize().catch(err => {
        console.error('Background init failed:', err.message);
        // CRITICAL: Mark as initialized even on failure so tools/list
        // doesn't hang waiting for discovery that will never complete.
        // The else branch in _waitForInit had NO timeout protection,
        // causing tools/list to block indefinitely on retry.
        this.initialized = true;
        this._initPromise = null;
      });
    }
    return this._initPromise;
  }

  /**
   * Wait for background initialization to complete
   * ALWAYS resolves within a bounded time - never hangs.
   * Uses discoveryTimeoutMs (default 6s) as the max wait.
   */
  async _waitForInit() {
    if (this.initialized) return;
    if (this._initPromise) {
      // Race the discovery against a timeout - if MCPO is slow,
      // serve whatever we have (even empty) rather than hanging
      const timeout = new Promise(resolve => setTimeout(resolve, this.discoveryTimeoutMs));
      await Promise.race([this._initPromise, timeout]);
      if (!this.initialized) {
        console.warn(`[TIMEOUT] MCPO discovery timed out after ${this.discoveryTimeoutMs}ms, serving with partial results`);
        this.initialized = true; // Mark as done so tools/list returns
      }
    } else {
      // BUG FIX: This path had NO timeout protection before.
      // If _initPromise was null (e.g., after a failed init attempt),
      // it would call initialize() directly and block indefinitely.
      // Now we race it against a timeout just like the promise path.
      console.warn('[INIT] _initPromise was null, initializing with timeout guard');
      const timeout = new Promise(resolve => setTimeout(resolve, this.discoveryTimeoutMs));
      await Promise.race([this.initialize(), timeout]);
      if (!this.initialized) {
        console.warn(`[TIMEOUT] MCPO discovery timed out after ${this.discoveryTimeoutMs}ms (retry path), serving with partial results`);
        this.initialized = true;
      }
    }
  }

  // =========================================================================
  // SERVER DISCOVERY
  // =========================================================================

  /**
   * Discover MCP servers by checking known server names
   * Uses caching for instant startup - tries cache first, then fetches from network
   */
  async _discoverServers() {
    const knownServers = [
      'memory', 'basic-memory', 'searxng', 'sequential-thinking', 'filesystem',
      'github', 'mcp-server-time', 'puppeteer', 'desktop-commander', 'chrome-tools',
      'ccxt', 'docfork', 'web3-research-mcp', 'cryptopanic-mcp-server', 'stable-diffusion',
      'code-research', 'coingecko', 'markdown-downloader', 'context7', 'mcp-deepwiki',
      'metatrader5', 'playwright', 'browser-tools'
    ];

    const discoveryPromises = knownServers.map(async (serverName) => {
      // First try cache
      const cachedSpec = this._loadCachedSpec(serverName);
      if (cachedSpec) {
        console.log(`[CACHE] Using cached spec for "${serverName}"`);
        return {
          name: serverName,
          openapiUrl: `${this.mcpoBaseUrl}/${serverName}/openapi.json`,
          openapiSpec: cachedSpec,
          toolsUrl: `${this.mcpoBaseUrl}/${serverName}/tools`,
          fromCache: true
        };
      }

      // Cache miss - fetch from network
      try {
        const openapiUrl = `${this.mcpoBaseUrl}/${serverName}/openapi.json`;

        const headers = {};
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }

        const response = await axios.get(openapiUrl, {
          headers,
          timeout: 3000 // 3s per server - 23 servers in parallel = max ~3s
        });

        if (response.data) {
          console.log(`Discovered server: ${serverName}`);
          // Save to cache for future use
          this._saveCachedSpec(serverName, response.data);
          return {
            name: serverName,
            openapiUrl: openapiUrl,
            openapiSpec: response.data,
            toolsUrl: `${this.mcpoBaseUrl}/${serverName}/tools`
          };
        }
      } catch (error) {
        // Try cache as fallback if network fails
        const cachedSpec = this._loadCachedSpec(serverName);
        if (cachedSpec) {
          console.log(`[CACHE] Network failed, using stale cache for "${serverName}"`);
          return {
            name: serverName,
            openapiUrl: `${this.mcpoBaseUrl}/${serverName}/openapi.json`,
            openapiSpec: cachedSpec,
            toolsUrl: `${this.mcpoBaseUrl}/${serverName}/tools`,
            fromCache: true,
            stale: true
          };
        }
        // Server not available, skip it
        console.log(`Server ${serverName} not available: ${error.message}`);
        return null;
      }
    });

    const discoveredServers = (await Promise.all(discoveryPromises)).filter(s => s !== null);

    for (const server of discoveredServers) {
      this.servers.set(server.name, server);
    }

    console.log(`Discovered ${this.servers.size} MCP servers`);
  }

  // =========================================================================
  // TOOL AGGREGATION
  // =========================================================================

  /**
   * Extract and aggregate tools from all discovered servers' OpenAPI specs
   */
  async _aggregateTools() {
    this.tools = [];
    this.toolServerMap.clear();

    for (const [serverName, server] of this.servers.entries()) {
      const serverInfo = server.openapiSpec?.info || {};
      const serverDescription = serverInfo.description || '';
      const serverTools = this._extractToolsFromOpenAPI(serverName, server.openapiSpec);

      for (const tool of serverTools) {
        // Check for name conflicts
        const existingToolIndex = this.tools.findIndex(t => t.originalName === tool.originalName);

        if (existingToolIndex !== -1) {
          // Conflict detected - rename with server prefix
          const existingTool = this.tools[existingToolIndex];
          console.warn(`Tool name conflict: ${tool.originalName} exists in ${existingTool.server} and ${serverName}`);

          // Rename existing tool
          this.tools[existingToolIndex].name = `${existingTool.server}::${existingTool.originalName}`;
          this.tools[existingToolIndex].description = `[${existingTool.server}] ${existingTool.description}`;

          // Update tool-server mapping
          this.toolServerMap.set(
            `${existingTool.server}::${existingTool.originalName}`,
            existingTool.server
          );

          // Rename the new tool too
          tool.name = `${serverName}::${tool.originalName}`;
          tool.description = `[${serverName}] ${tool.description}`;
        } else {
          // No conflict, rename with server prefix for consistency
          tool.name = `${serverName}::${tool.originalName}`;
          tool.description = `[${serverName}] ${tool.description}`;
        }

        // Add the tool
        this.tools.push(tool);
        this.toolServerMap.set(tool.name, serverName);
      }

      console.log(`${serverName}: ${serverTools.length} tools`);
    }

    console.log(`Total aggregated tools: ${this.tools.length}`);
  }

  /**
   * Extract tool definitions from OpenAPI spec with deep $ref resolution
   */
  _extractToolsFromOpenAPI(serverName, openapiSpec) {
    const tools = [];
    const { paths = {}, info = {} } = openapiSpec;
    const serverDescription = info.description || '';

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, spec] of Object.entries(methods)) {
        if (method !== 'post') continue; // MCP tools are POST requests

        const toolName = path.replace(/^\//, '').replace(/\//g, '_');

        // Build rich description from OpenAPI spec
        const description = this._buildToolDescription(spec, serverName, serverDescription);

        // Extract fully-resolved input schema
        const inputSchema = this._extractInputSchema(spec, openapiSpec);

        // Infer MCP annotations from operation semantics
        const annotations = this._inferAnnotations(spec, serverName, toolName);

        tools.push({
          name: toolName,
          originalName: toolName,
          server: serverName,
          description: description,
          inputSchema: inputSchema,
          annotations: annotations,
          // Internal metadata for proxy (not sent to client)
          _path: path,
          _method: method,
          _serverName: serverName
        });
      }
    }

    return tools;
  }

  // =========================================================================
  // DEEP $REF RESOLUTION
  // =========================================================================

  /**
   * Deeply resolve all $ref references in a schema, with caching.
   * Handles: $ref, allOf, oneOf, anyOf, nested properties, items.$ref
   *
   * @param {object} schema - The schema to resolve
   * @param {object} openapiSpec - The full OpenAPI spec (for resolving refs)
   * @param {Set} [visitedRefs] - Cycle detection set
   * @returns {object} - Fully resolved schema with no $ref remaining
   */
  _deepResolveSchema(schema, openapiSpec, visitedRefs) {
    if (!schema || typeof schema !== 'object') return schema;

    // Initialize visited set for cycle detection
    if (!visitedRefs) visitedRefs = new Set();

    // Resolve $ref
    if (schema.$ref) {
      const refPath = schema.$ref;

      // Cycle detection - return empty object to prevent infinite recursion
      if (visitedRefs.has(refPath)) {
        console.warn(`Circular $ref detected: ${refPath}`);
        return { type: 'object', description: '(circular reference)' };
      }
      visitedRefs.add(refPath);

      // Check cache
      if (this._schemaCache.has(refPath)) {
        return this._schemaCache.get(refPath);
      }

      // Resolve the reference path: #/components/schemas/ModelName
      const parts = refPath.replace('#/', '').split('/');
      let resolved = openapiSpec;
      for (const part of parts) {
        resolved = resolved?.[part];
      }

      if (!resolved) {
        console.warn(`Failed to resolve $ref: ${refPath}`);
        return { type: 'object', description: `(unresolved ref: ${refPath})` };
      }

      // Deeply resolve the resolved schema
      const result = this._deepResolveSchema(resolved, openapiSpec, visitedRefs);
      this._schemaCache.set(refPath, result);
      return result;
    }

    // Handle allOf - merge all subschemas
    if (schema.allOf) {
      const merged = { type: 'object', properties: {}, required: [] };
      for (const subSchema of schema.allOf) {
        const resolved = this._deepResolveSchema(subSchema, openapiSpec, new Set(visitedRefs));
        if (resolved.properties) {
          Object.assign(merged.properties, resolved.properties);
        }
        if (resolved.required) {
          merged.required.push(...resolved.required);
        }
        // Inherit description if not already set
        if (!merged.description && resolved.description) {
          merged.description = resolved.description;
        }
      }
      if (merged.required.length === 0) delete merged.required;
      return merged;
    }

    // Handle oneOf/anyOf - return the first option with a note
    if (schema.oneOf || schema.anyOf) {
      const options = schema.oneOf || schema.anyOf;
      // For MCP, we simplify to the first non-null option
      const firstOption = options.find(opt => {
        const resolved = this._deepResolveSchema(opt, openapiSpec, new Set(visitedRefs));
        return resolved.type !== 'null';
      });

      if (firstOption) {
        return this._deepResolveSchema(firstOption, openapiSpec, new Set(visitedRefs));
      }
      return { type: 'string', description: schema.description || 'One of multiple types' };
    }

    // Recursively resolve properties
    if (schema.properties) {
      const resolved = { ...schema };

      // Copy over scalar fields
      for (const key of ['type', 'description', 'title', 'default', 'enum', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern']) {
        if (schema[key] !== undefined) resolved[key] = schema[key];
      }

      // Deep-resolve each property
      resolved.properties = {};
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        resolved.properties[propName] = this._deepResolveSchema(propSchema, openapiSpec, new Set(visitedRefs));
      }

      // Handle required array
      if (schema.required) {
        resolved.required = [...schema.required];
      }

      // Handle items (for arrays)
      if (schema.items) {
        resolved.items = this._deepResolveSchema(schema.items, openapiSpec, new Set(visitedRefs));
      }

      return resolved;
    }

    // Handle items (for arrays without properties)
    if (schema.items) {
      const resolved = { ...schema };
      for (const key of ['type', 'description', 'title', 'default', 'enum', 'format']) {
        if (schema[key] !== undefined) resolved[key] = schema[key];
      }
      resolved.items = this._deepResolveSchema(schema.items, openapiSpec, new Set(visitedRefs));
      return resolved;
    }

    // Simple scalar schema (string, number, integer, boolean, null)
    // Just return a clean copy
    const clean = {};
    for (const key of ['type', 'description', 'title', 'default', 'enum', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']) {
      if (schema[key] !== undefined) clean[key] = schema[key];
    }
    return Object.keys(clean).length > 0 ? clean : schema;
  }

  // =========================================================================
  // INPUT SCHEMA EXTRACTION
  // =========================================================================

  /**
   * Extract a fully-resolved MCP-compatible inputSchema from an OpenAPI operation.
   * Deep-resolves all $ref references so the AI sees every field.
   */
  _extractInputSchema(spec, openapiSpec) {
    const rawSchema = spec.requestBody?.content?.['application/json']?.schema;

    if (!rawSchema) {
      // No request body - tool takes no arguments
      return {
        type: 'object',
        properties: {},
        required: []
      };
    }

    // Deep-resolve the schema
    const resolved = this._deepResolveSchema(rawSchema, openapiSpec);

    // Build clean MCP inputSchema
    const properties = resolved.properties || {};
    const required = resolved.required || [];

    // Clean up each property for MCP consumption
    const cleanProperties = {};
    for (const [propName, propSchema] of Object.entries(properties)) {
      cleanProperties[propName] = this._cleanPropertyForMCP(propSchema);
    }

    return {
      type: 'object',
      properties: cleanProperties,
      required: required
    };
  }

  /**
   * Clean a resolved property schema for MCP consumption.
   * Removes internal OpenAPI noise, preserves description and type info.
   * Flattens nested object properties that came from $ref resolution
   * when the parent has a description (like metatrader5's request field).
   */
  _cleanPropertyForMCP(propSchema) {
    if (!propSchema || typeof propSchema !== 'object') {
      return { type: 'string', description: 'Unknown property' };
    }

    const clean = {};

    // Determine the effective type
    if (propSchema.type) {
      clean.type = propSchema.type;
    } else if (propSchema.properties) {
      clean.type = 'object';
    } else if (propSchema.items) {
      clean.type = 'array';
    } else {
      clean.type = 'string'; // fallback
    }

    // Copy description - this is THE most important field for AI understanding
    if (propSchema.description) {
      clean.description = propSchema.description;
    }

    // Copy title as fallback description
    if (!clean.description && propSchema.title) {
      clean.description = propSchema.title;
    }

    // Copy default value
    if (propSchema.default !== undefined) {
      clean.default = propSchema.default;
    }

    // Copy enum values
    if (propSchema.enum) {
      clean.enum = propSchema.enum;
    }

    // Copy format hints
    if (propSchema.format) {
      clean.format = propSchema.format;
    }

    // Handle array items
    if (propSchema.items) {
      if (propSchema.items.properties) {
        // Array of objects - include their structure for AI understanding
        clean.items = {
          type: 'object',
          properties: {}
        };
        for (const [itemName, itemSchema] of Object.entries(propSchema.items.properties)) {
          clean.items.properties[itemName] = this._cleanPropertyForMCP(itemSchema);
        }
        if (propSchema.items.required) {
          clean.items.required = propSchema.items.required;
        }
      } else {
        // Array of primitives
        clean.items = this._cleanPropertyForMCP(propSchema.items);
      }
    }

    // Handle nested object properties (flattened $ref)
    if (propSchema.properties && clean.type === 'object') {
      clean.properties = {};
      for (const [subName, subSchema] of Object.entries(propSchema.properties)) {
        clean.properties[subName] = this._cleanPropertyForMCP(subSchema);
      }
      if (propSchema.required) {
        clean.required = propSchema.required;
      }
    }

    // Handle anyOf that includes null (optional fields)
    // e.g., anyOf: [{type: "number"}, {type: "null"}] means optional number
    // This is already resolved by _deepResolveSchema, but just in case
    // we see a leftover, simplify it
    if (propSchema.anyOf && !propSchema.type) {
      const nonNull = propSchema.anyOf.find(s => s.type !== 'null');
      if (nonNull) {
        const cleaned = this._cleanPropertyForMCP(nonNull);
        if (clean.description) cleaned.description = clean.description || cleaned.description;
        return cleaned;
      }
    }

    return clean;
  }

  // =========================================================================
  // RICH DESCRIPTION BUILDER
  // =========================================================================

  /**
   * Build a rich, AI-friendly tool description from OpenAPI spec.
   * Uses the operation's description field (most detailed) as primary,
   * falls back to summary, then path.
   * Includes parameter hints from the description field.
   */
  _buildToolDescription(spec, serverName, serverDescription) {
    // Priority: description > summary > generated
    // OpenAPI 'description' is typically the most detailed and useful
    let description = '';

    if (spec.description) {
      description = spec.description;
    } else if (spec.summary) {
      description = spec.summary;
    } else {
      description = `Tool: ${spec.operationId || 'unknown'}`;
    }

    // Clean up common MCPO description patterns
    // MCPO often duplicates the summary in the description
    if (spec.summary && spec.description && spec.description !== spec.summary) {
      // Both exist and differ - use the longer one (usually description)
      if (spec.description.length > spec.summary.length) {
        description = spec.description;
      } else {
        description = spec.summary;
      }
    }

    // Trim whitespace and normalize
    description = description.trim().replace(/\s+/g, ' ');

    // Truncate extremely long descriptions (keep reasonable for MCP)
    if (description.length > 2000) {
      description = description.substring(0, 1997) + '...';
    }

    return description;
  }

  // =========================================================================
  // MCP ANNOTATIONS
  // =========================================================================

  /**
   * Infer MCP tool annotations from the operation and server context.
   * MCP annotations help the AI understand tool behavior:
   * - readOnlyHint: tool only reads data, no side effects
   * - destructiveHint: tool can delete/destroy data
   * - idempotentHint: calling twice has same effect as once
   * - openWorldHint: tool interacts with external services
   */
  _inferAnnotations(spec, serverName, toolName) {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    };

    // Infer from tool name patterns
    const nameLower = toolName.toLowerCase();

    // Read-only tools
    if (
      nameLower.includes('get') ||
      nameLower.includes('list') ||
      nameLower.includes('read') ||
      nameLower.includes('search') ||
      nameLower.includes('fetch') ||
      nameLower.includes('view') ||
      nameLower.includes('price') ||
      nameLower.includes('market') ||
      nameLower.includes('info') ||
      nameLower.includes('status') ||
      nameLower.includes('graph') ||
      nameLower.includes('ticks') ||
      nameLower.includes('rates') ||
      nameLower.includes('account') ||
      nameLower.includes('terminal') ||
      nameLower.includes('version') ||
      nameLower.includes('symbols') ||
      nameLower.includes('screenshot') ||
      nameLower.includes('snapshot') ||
      nameLower.includes('audit') ||
      nameLower.includes('logs') ||
      nameLower.includes('console') ||
      nameLower.includes('network') ||
      nameLower.includes('docs') ||
      nameLower.includes('wiki') ||
      nameLower.includes('time') ||
      nameLower.includes('activity') ||
      nameLower.includes('directory') ||
      nameLower.includes('tree') ||
      nameLower.includes('canvas') ||
      nameLower.includes('build_context') ||
      nameLower.includes('schema_diff') ||
      nameLower.includes('schema_infer') ||
      nameLower.includes('schema_validate') ||
      nameLower.includes('release_notes') ||
      nameLower.includes('trending') ||
      nameLower.includes('top_volume') ||
      nameLower.includes('volume_history') ||
      nameLower.includes('price_change') ||
      nameLower.includes('historical') ||
      nameLower.includes('deepwiki') ||
      nameLower.includes('resolve-library') ||
      nameLower.includes('get-library') ||
      nameLower.includes('coingecko_list') ||
      nameLower.includes('coingecko_coin') ||
      nameLower.includes('cloud_info')
    ) {
      annotations.readOnlyHint = true;
    }

    // Destructive tools
    if (
      nameLower.includes('delete') ||
      nameLower.includes('remove') ||
      nameLower.includes('destroy') ||
      nameLower.includes('kill') ||
      nameLower.includes('terminate') ||
      nameLower.includes('force_terminate') ||
      nameLower.includes('wipe') ||
      nameLower.includes('clean')
    ) {
      annotations.destructiveHint = true;
    }

    // Idempotent tools (PUT-like, create-if-not-exists)
    if (
      nameLower.includes('create_entities') ||
      nameLower.includes('write_note') ||
      nameLower.includes('write_file') ||
      nameLower.includes('set_') ||
      nameLower.includes('update') ||
      nameLower.includes('login') ||
      nameLower.includes('initialize') ||
      nameLower.includes('shutdown') ||
      nameLower.includes('symbol_select')
    ) {
      annotations.idempotentHint = true;
    }

    // Open world tools (interact with external services/internet)
    if (
      nameLower.includes('search') ||
      nameLower.includes('web') ||
      nameLower.includes('url') ||
      nameLower.includes('fetch') ||
      nameLower.includes('navigate') ||
      nameLower.includes('download') ||
      nameLower.includes('news') ||
      nameLower.includes('coin') ||
      nameLower.includes('ohlcv') ||
      nameLower.includes('price') ||
      nameLower.includes('trending') ||
      nameLower.includes('top_volume') ||
      nameLower.includes('volume_history') ||
      nameLower.includes('github') ||
      nameLower.includes('deepwiki') ||
      nameLower.includes('context7') ||
      nameLower.includes('docfork') ||
      nameLower.includes('code_research') ||
      nameLower.includes('searxng') ||
      nameLower.includes('playwright') ||
      nameLower.includes('puppeteer') ||
      nameLower.includes('chrome') ||
      nameLower.includes('browser') ||
      nameLower.includes('order_send') ||
      nameLower.includes('order_check') ||
      nameLower.includes('generate_image') ||
      nameLower.includes('upscale')
    ) {
      annotations.openWorldHint = true;
    }

    // Server-level overrides
    // These servers are inherently read-only or external
    const readOnlyServers = [
      'searxng', 'context7', 'docfork', 'code-research', 'mcp-deepwiki',
      'coingecko', 'ccxt', 'mcp-server-time', 'cryptopanic-mcp-server',
      'browser-tools'
    ];
    const openWorldServers = [
      'searxng', 'context7', 'docfork', 'code-research', 'mcp-deepwiki',
      'coingecko', 'ccxt', 'cryptopanic-mcp-server', 'github',
      'playwright', 'puppeteer', 'chrome-tools', 'browser-tools',
      'stable-diffusion', 'metatrader5', 'markdown-downloader',
      'web3-research-mcp'
    ];

    if (readOnlyServers.includes(serverName) && !nameLower.includes('download')) {
      annotations.readOnlyHint = true;
    }

    if (openWorldServers.includes(serverName)) {
      annotations.openWorldHint = true;
    }

    // Memory server: reads are read-only, writes/deletes are destructive
    if (serverName === 'memory' || serverName === 'basic-memory') {
      if (nameLower.includes('delete') || nameLower.includes('remove')) {
        annotations.destructiveHint = true;
        annotations.readOnlyHint = false;
      } else if (
        nameLower.includes('create') ||
        nameLower.includes('add') ||
        nameLower.includes('write') ||
        nameLower.includes('edit') ||
        nameLower.includes('move')
      ) {
        annotations.readOnlyHint = false;
      }
    }

    // Desktop-commander: process management is destructive
    if (serverName === 'desktop-commander') {
      if (nameLower.includes('kill') || nameLower.includes('terminate') || nameLower.includes('force_terminate')) {
        annotations.destructiveHint = true;
        annotations.readOnlyHint = false;
      }
    }

    // Metatrader5: order_send is destructive (real money), order_check is read-only
    if (serverName === 'metatrader5') {
      if (nameLower.includes('order_send')) {
        annotations.destructiveHint = true;
        annotations.readOnlyHint = false;
        annotations.openWorldHint = true;
      } else if (nameLower.includes('order_check')) {
        annotations.readOnlyHint = true;
      }
    }

    // Stable-diffusion: generate/upscale are idempotent and open-world
    if (serverName === 'stable-diffusion') {
      if (nameLower.includes('generate') || nameLower.includes('upscale')) {
        annotations.idempotentHint = false; // Each call produces different results
        annotations.openWorldHint = true;
      }
    }

    return annotations;
  }

  // =========================================================================
  // JSON-RPC HANDLERS
  // =========================================================================

  /**
   * Handle JSON-RPC initialize request
   * Responds IMMEDIATELY with capabilities - does NOT wait for MCPO discovery.
   * MCPO server discovery runs in background and completes before tools/list.
   */
  async handleInitialize(params) {
    // Kick off discovery in the background (non-blocking)
    this._startBackgroundInit();

    return {
      protocolVersion: '2025-03-26',
      serverInfo: {
        name: 'MCP Translator Proxy',
        version: '2.0.0'
      },
      capabilities: {
        tools: {},
        // NOTE: resources intentionally omitted. OpenClaude (fork of Claude Code)
        // has a bug where the mcpSkills.js module is a stub that doesn't export
        // fetchMcpSkillsForClient. Advertising resources capability triggers a call
        // to that undefined function, causing "fetchMcpSkillsForClient is not a function".
        // This proxy only provides tools via MCPO, not MCP resources.
        notifications: {}
      }
    };
  }

  /**
   * Handle tools/list request
   * Returns fully-resolved tool definitions with rich schemas and annotations.
   */
  async handleToolsList() {
    // Wait for background init to complete if needed
    await this._waitForInit();

    return {
      tools: this.tools.map(tool => {
        const mcpTool = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        };

        // Include annotations if any are non-default
        if (tool.annotations) {
          const hasNonDefault = (
            tool.annotations.readOnlyHint ||
            tool.annotations.destructiveHint ||
            tool.annotations.idempotentHint ||
            tool.annotations.openWorldHint
          );
          if (hasNonDefault) {
            mcpTool.annotations = tool.annotations;
          }
        }

        return mcpTool;
      })
    };
  }

  /**
   * Handle tool call by proxying to MCPO REST API
   * NEVER throws - all errors returned as {content, isError: true}
   */
  async handleToolCall(params) {
    const { name, arguments: args } = params;

    // Wait for background init to complete if needed
    await this._waitForInit();

    console.log(`=== TOOL CALL REQUEST ===`);
    console.log(` Tool name received: "${name}"`);
    console.log(` Arguments: ${JSON.stringify(args)}`);

    // Find which server handles this tool
    const parsed = this._resolveToolName(name);

    if (parsed.error) {
      console.error(` TOOL NOT FOUND: "${name}"`);
      console.error(` Available tools (first 20): ${this.tools.map(t => t.name).slice(0, 20).join(', ')}`);
      return parsed.error;
    }

    const { serverName, originalToolName } = parsed;

    const server = this.servers.get(serverName);
    if (!server) {
      console.error(` SERVER NOT FOUND: "${serverName}"`);
      return {
        content: [{
          type: 'text',
          text: `Server "${serverName}" not found. Available: ${Array.from(this.servers.keys()).join(', ')}`
        }],
        isError: true
      };
    }

    // Find the tool definition
    const tool = this.tools.find(t => t.server === serverName && t.originalName === originalToolName);
    if (!tool) {
      console.error(` TOOL "${originalToolName}" NOT FOUND IN SERVER "${serverName}"`);
      return {
        content: [{
          type: 'text',
          text: `Tool "${originalToolName}" not found in server "${serverName}"`
        }],
        isError: true
      };
    }

    // Make the REST API call to MCPO
    const url = `${this.mcpoBaseUrl}/${serverName}${tool._path}`;
    console.log(` Proxying to: ${url}`);
    console.log(` Body: ${JSON.stringify(args)}`);

    try {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      const startTime = Date.now();

      // Use retry logic for network errors
      const response = await this._executeWithRetry(async () => {
        return await axios.post(url, args, {
          headers,
          timeout: 30000,
          validateStatus: () => true // NEVER throw on any HTTP status
        });
      }, `MCPO call: ${serverName}/${originalToolName}`);
      const elapsed = Date.now() - startTime;

      console.log(` MCPO response: HTTP ${response.status} (${elapsed}ms)`);

      // Handle non-2xx responses gracefully
      if (response.status >= 400) {
        const errorDetail = typeof response.data === 'object'
          ? JSON.stringify(response.data)
          : String(response.data);
        console.error(` MCPO error: HTTP ${response.status} - ${errorDetail.substring(0, 500)}`);
        return {
          content: [{
            type: 'text',
            text: `MCPO error HTTP ${response.status}: ${errorDetail}`
          }],
          isError: true
        };
      }

      const resultText = JSON.stringify(response.data, null, 2);
      console.log(` MCPO success: ${resultText.length} bytes`);
      return {
        content: [{
          type: 'text',
          text: resultText
        }],
        isError: false
      };
    } catch (error) {
      // This catch handles network/timeout errors only (HTTP status errors handled above)
      console.error(` Network/timeout error: ${error.code || error.message}`);

      return {
        content: [{
          type: 'text',
          text: `Network error calling ${serverName}/${originalToolName}: ${error.code || error.message}`
        }],
        isError: true
      };
    }
  }

  // =========================================================================
  // TOOL NAME RESOLUTION
  // =========================================================================

  /**
   * Resolve a tool name to {serverName, originalToolName} or {error}.
   * Supports multiple formats:
   * - "server::tool" (our native format)
   * - "server_tool" (underscore format)
   * - plain "tool" (search all tools)
   */
  _resolveToolName(name) {
    let serverName, originalToolName;

    if (name.includes('::')) {
      // Our native format: "searxng::searxng_web_search"
      const parts = name.split('::');
      serverName = parts[0];
      originalToolName = parts[1];
      console.log(` Parsed as [::] server="${serverName}" tool="${originalToolName}"`);
    } else if (name.includes('_') && !name.startsWith('_')) {
      // Try to find exact match first
      const tool = this.tools.find(t => t.name === name || t.originalName === name);
      if (tool) {
        serverName = tool.server;
        originalToolName = tool.originalName;
        console.log(` Parsed as [exact_match] server="${serverName}" tool="${originalToolName}"`);
      } else {
        // Try splitting on first underscore to find a server match
        const underscoreIdx = name.indexOf('_');
        const possibleServer = name.substring(0, underscoreIdx);
        const possibleTool = name.substring(underscoreIdx + 1);

        if (this.servers.has(possibleServer)) {
          serverName = possibleServer;
          originalToolName = possibleTool;
          console.log(` Parsed as [first_underscore] server="${serverName}" tool="${originalToolName}"`);
        } else {
          // Last resort: search all tools by name
          const found = this.tools.find(t =>
            t.originalName === name ||
            t.name === name ||
            t.name.endsWith('::' + name) ||
            t.name.endsWith('_' + name.replace(/_/g, '_'))
          );
          if (!found) {
            return {
              error: {
                content: [{
                  type: 'text',
                  text: `Tool "${name}" not found. Available tools: ${this.tools.map(t => t.name).slice(0, 10).join(', ')}...`
                }],
                isError: true
              }
            };
          }
          serverName = found.server;
          originalToolName = found.originalName;
          console.log(` Parsed as [fuzzy] server="${serverName}" tool="${originalToolName}"`);
        }
      }
    } else {
      // Plain name, search by originalName
      const tool = this.tools.find(t => t.originalName === name || t.name === name);
      if (!tool) {
        return {
          error: {
            content: [{
              type: 'text',
              text: `Tool "${name}" not found.`
            }],
            isError: true
          }
        };
      }
      serverName = tool.server;
      originalToolName = tool.originalName;
      console.log(` Parsed as [plain] server="${serverName}" tool="${originalToolName}"`);
    }

    return { serverName, originalToolName };
  }

  // =========================================================================

  // =========================================================================
  // TOOL SEARCH / DISCOVERY
  // =========================================================================

  /**
   * Search for tools matching a query
   * @param {string} query - Search query (keyword, tool name, or server name)
   * @param {Object} options - Search options
   * @param {string} options.server - Filter by server name
   * @param {number} options.limit - Max results to return (default: 20)
   * @returns {Array} - Array of matching tools with relevance scores
   */
  searchTools(query, options = {}) {
    const { server: serverFilter, limit = 20 } = options;

    if (!query || query.trim() === '') {
      return this.tools
        .filter(t => !serverFilter || t.server === serverFilter)
        .slice(0, limit)
        .map(t => ({ ...t, relevance: 1 }));
    }

    const searchTerms = query.toLowerCase().trim().split(/\s+/);

    // Score each tool
    const scored = this.tools
      .filter(t => !serverFilter || t.server === serverFilter)
      .map(tool => {
        let score = 0;
        const name = (tool.originalName || tool.name || '').toLowerCase();
        const desc = (tool.description || '').toLowerCase();
        const server = (tool.server || '').toLowerCase();

        for (const term of searchTerms) {
          if (term.length < 2) continue;

          // Exact match (highest score)
          if (name === term) score += 100;
          else if (name.startsWith(term)) score += 80;
          else if (name.includes(term)) score += 60;

          // Description match
          if (desc.includes(term)) score += 30;

          // Server match
          if (server === term) score += 50;
          else if (server.includes(term)) score += 20;

          // Fuzzy match (partial word)
          const nameWords = name.split(/[_\-\s]/);
          if (nameWords.some(w => w.startsWith(term) || w.includes(term))) score += 25;
        }

        return { ...tool, relevance: score };
      })
      .filter(t => t.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance);

    return scored.slice(0, limit);
  }

  /**
   * Get tools organized by server
   * @returns {Map} - Map of serverName -> tools array
   */
  getToolsByServer() {
    const byServer = new Map();
    for (const tool of this.tools) {
      if (!byServer.has(tool.server)) {
        byServer.set(tool.server, []);
      }
      byServer.get(tool.server).push(tool);
    }
    return byServer;
  }

  /**
   * Get list of all available server names
   * @returns {Array} - Array of server names
   */
  getServers() {
    return Array.from(this.servers.keys());
  }

  // MAIN REQUEST HANDLER
  // =========================================================================

  /**
   * Handle any JSON-RPC request or notification
   * Returns null for notifications (no response should be sent)
   */
  async handleRequest(request) {
    const { method, params, id } = request;

    console.log(`>>> INCOMING REQUEST: ${method} (id: ${id ?? 'notification'})`);
    if (params) {
      if (method === 'tools/call') {
        console.log(` params.name: "${params.name}"`);
        console.log(` params.arguments: ${JSON.stringify(params.arguments || {})}`);
      } else if (method === 'initialize') {
        console.log(` params.clientInfo: ${JSON.stringify(params.clientInfo || {})}`);
      } else {
        console.log(` params: ${JSON.stringify(params).substring(0, 200)}`);
      }
    }

    try {
      // Handle notifications (no response needed per JSON-RPC spec)
      if (method.startsWith('notifications/')) {
        console.log(` Notification: ${method} (no response sent)`);
        // For 'initialized' notification, kick off background discovery
        // if it hasn't started yet (some clients send initialized after
        // receiving the initialize response)
        if (method === 'notifications/initialized' && !this._initPromise) {
          this._startBackgroundInit();
        }
        return null;
      }

      let result;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;
        case 'tools/list':
          result = await this.handleToolsList();
          break;
        case 'tools/call':
          result = await this.handleToolCall(params);
          break;
        case 'ping':
          result = {};
          break;
        case 'resources/list':
          result = { resources: [] };
          break;
        case 'prompts/list':
          result = { prompts: [] };
          break;
        default:
          console.error(` Unknown method: ${method}`);
          throw new Error(`Method ${method} not supported`);
      }

      console.log(`<<< RESPONSE: ${method} OK (id: ${id ?? 'none'})`);
      return {
        jsonrpc: '2.0',
        id,
        result
      };
    } catch (error) {
      console.error(`<<< RESPONSE: ${method} ERROR: ${error.message} (id: ${id ?? 'none'})`);

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        }
      };
    }
  }

  // =========================================================================
  // STATUS
  // =========================================================================

  /**
   * Get status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      servers: Array.from(this.servers.keys()),
      toolCount: this.tools.length,
      mcpoBaseUrl: this.mcpoBaseUrl
    };
  }
}

module.exports = MCPProxyHandler;
