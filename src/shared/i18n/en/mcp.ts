// MCP servers view.
export default {
  // MCP servers
  'title': 'MCP servers',
  'subtitle': 'Model Context Protocol servers available to the agent.',
  'refresh': 'Refresh',
  'addServer': 'Add server',
  'loading': 'Loading MCP config…',
  'empty': 'No MCP servers found in your local {path} or any connected WSL distro. Add one to give the agent extra tools and context.',
  'status.needsAuth': 'Needs authentication',
  'status.ready': 'Ready',
  'chip.authNeeded': 'auth needed',
  'remove': 'Remove',
  'noTransport': 'no transport details',
  'project': 'project: {path}',
  'add.title': 'Add MCP server',
  'add.name': 'Name',
  'add.transport': 'Transport',
  'add.stdio': 'stdio (command)',
  'add.http': 'HTTP / SSE (url)',
  'add.command': 'Command',
  'add.arguments': 'Arguments',
  'add.url': 'URL',
  'add.hint': 'Saved to ~/.claude.json (global scope). A backup is written first.',
  'add.button': 'Add'
} satisfies Record<string, string>
