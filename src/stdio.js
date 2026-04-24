#!/usr/bin/env node

/**
 * MCPO Translator - Stdio Transport
 *
 * Reads JSON-RPC messages from stdin (one per line), processes them
 * through MCPProxyHandler, and writes responses to stdout.
 *
 * This bypasses all OAuth/HTTP complexity - OpenClaude spawns this
 * process and communicates via stdin/stdout using the MCP protocol.
 */

// Load .env from the script's own directory (not process.cwd())
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const MCPProxyHandler = require('./mcp-proxy-handler');

// Log file for debugging - write to /tmp so we can see what OpenClaude sends
const LOG_FILE = '/tmp/mcpo-translator.log';
let logStream = null;
try {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write(`\n${'='.repeat(60)}\n`);
  logStream.write(`MCPO Translator started at ${new Date().toISOString()}\n`);
  logStream.write(`${'='.repeat(60)}\n`);
} catch (e) {
  // Can't write log file, that's OK
}

function logToFile(msg) {
  if (logStream) {
    try {
      logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
    } catch (_) {}
  }
}

// Redirect all console output to stderr AND log file
// stdout is RESERVED for MCP JSON-RPC messages only
console.log = (...args) => {
  const msg = '[LOG] ' + args.join(' ');
  process.stderr.write(msg + '\n');
  logToFile(msg);
};
console.error = (...args) => {
  const msg = '[ERR] ' + args.join(' ');
  process.stderr.write(msg + '\n');
  logToFile(msg);
};
console.warn = (...args) => {
  const msg = '[WARN] ' + args.join(' ');
  process.stderr.write(msg + '\n');
  logToFile(msg);
};
console.info = (...args) => {
  const msg = '[INFO] ' + args.join(' ');
  process.stderr.write(msg + '\n');
  logToFile(msg);
};

const handler = new MCPProxyHandler();
let pendingRequests = 0;
let stdinClosed = false;

/**
 * Write a JSON-RPC message to stdout (single line JSON + newline)
 */
function sendMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(json + '\n');
  logToFile(`OUT >> ${json.substring(0, 500)}${json.length > 500 ? '...' : ''}`);
}

/**
 * Parse and handle a single JSON-RPC message
 */
async function handleMessage(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (e) {
    console.error('Failed to parse JSON-RPC:', e.message);
    return;
  }

  // Log the FULL incoming request to log file (truncated for tools/list)
  const method = request.method || 'unknown';
  const reqLog = method === 'tools/list'
    ? `IN << ${method} (id: ${request.id ?? 'notification'})`
    : `IN << ${method} (id: ${request.id ?? 'notification'}) data: ${trimmed.substring(0, 2000)}`;
  logToFile(reqLog);

  console.log(`<< ${method} (id: ${request.id ?? 'notification'})`);
  pendingRequests++;

  try {
    // handleRequest now manages its own initialization:
    // - initialize() responds immediately (background MCPO discovery)
    // - tools/list and tools/call wait for discovery to finish
    const response = await handler.handleRequest(request);

    // null response = notification (no response should be sent per JSON-RPC spec)
    if (response === null) {
      console.log('>> Notification acknowledged');
      return;
    }

    if (response.error) {
      console.error(`>> Error: ${response.error?.message || 'unknown'} (id: ${request.id ?? 'none'})`);
    } else {
      console.log(`>> OK (id: ${request.id ?? 'none'})`);
    }

    sendMessage(response);
  } catch (error) {
    console.error('Unhandled error:', error.message);
    logToFile(`UNHANDLED ERROR: ${error.message}\n${error.stack}`);
    sendMessage({
      jsonrpc: '2.0',
      id: request.id || null,
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message
      }
    });
  } finally {
    pendingRequests--;
    // If stdin has closed and no pending requests, exit cleanly
    if (stdinClosed && pendingRequests === 0) {
      console.log('All requests processed, stdin closed - exiting');
      if (logStream) logStream.end();
      process.exit(0);
    }
  }
}

// Read line-by-line from stdin
let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  // Process complete lines
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.substring(0, newlineIdx);
    buffer = buffer.substring(newlineIdx + 1);
    handleMessage(line);
  }
});

process.stdin.on('end', () => {
  stdinClosed = true;
  // Process any remaining data in buffer (line without trailing newline)
  if (buffer.trim()) {
    handleMessage(buffer);
    buffer = '';
  }
  // Don't exit immediately - let pending async requests finish
  // The handleMessage finally block will exit when ready
  if (pendingRequests === 0) {
    console.log('Stdin closed, no pending requests - exiting');
    if (logStream) logStream.end();
    process.exit(0);
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
  logToFile(`UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}`);
  if (logStream) logStream.end();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  logToFile(`UNHANDLED REJECTION: ${reason}`);
  if (logStream) logStream.end();
  process.exit(1);
});

console.log('MCPO Translator stdio transport ready - awaiting MCP requests');
console.log(`Log file: ${LOG_FILE}`);
