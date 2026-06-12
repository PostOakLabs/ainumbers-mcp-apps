// AINumbers MCP Apps server — stdio entrypoint.
// Used by the Glama containerized build (mcp-proxy spawns this as a stdio MCP server for
// introspection / scoring) and by any stdio MCP host. Reuses the exact same tool + resource
// registration as the streamable-HTTP server in server.mjs — single source of truth.
//
//   node stdio.mjs                 → speaks MCP over stdin/stdout
//   node server.mjs                → streamable HTTP at http://localhost:3300/mcp (production)

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.mjs';

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
