import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFinanceServer } from "./tools";

/**
 * The MCP server over stdio, as assistants (Claude, Cursor, LM Studio...) launch it.
 *
 * stdout carries the protocol, so nothing else may print there: anything this
 * process wants to say goes to stderr.
 *
 *   npm run mcp                         from finance/, on finance/data
 *   FINANCE_DATA_DIR=... node mcp.js    the release app's compiled copy
 */
console.log = console.error;

// Not top-level await: the release app compiles this to CommonJS.
createFinanceServer()
  .connect(new StdioServerTransport())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
