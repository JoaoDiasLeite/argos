// Entry of the `ops` MCP relay when started with ELECTRON_RUN_AS_NODE=1 (its own bundle,
// out/main/ops-relay.js; see electron.vite.config.ts and ops-mcp-config.ts). Nothing here
// may import electron.
import { runOpsRelay } from './ops-relay'

void runOpsRelay()
