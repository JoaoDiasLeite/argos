import type en from '../en/mcp'

const mcp: Record<keyof typeof en, string> = {
  // MCP servers
  'title': 'Servidores MCP',
  'subtitle': 'Servidores Model Context Protocol disponíveis para o agente.',
  'refresh': 'Atualizar',
  'addServer': 'Adicionar servidor',
  'loading': 'A carregar a configuração MCP…',
  'empty': 'Não foram encontrados servidores MCP no seu {path} local nem em nenhuma distro WSL ligada. Adicione um para dar ao agente ferramentas e contexto adicionais.',
  'status.needsAuth': 'Requer autenticação',
  'status.ready': 'Pronto',
  'chip.authNeeded': 'requer autenticação',
  'remove': 'Remover',
  'noTransport': 'sem detalhes de transporte',
  'project': 'projeto: {path}',
  'add.title': 'Adicionar servidor MCP',
  'add.name': 'Nome',
  'add.transport': 'Transporte',
  'add.stdio': 'stdio (comando)',
  'add.http': 'HTTP / SSE (url)',
  'add.command': 'Comando',
  'add.arguments': 'Argumentos',
  'add.url': 'URL',
  'add.hint': 'Guardado em ~/.claude.json (âmbito global). É feita primeiro uma cópia de segurança.',
  'add.button': 'Adicionar'
}

export default mcp
