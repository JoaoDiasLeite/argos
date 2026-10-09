import type en from '../en/onboarding'

const onboarding: Record<keyof typeof en, string> = {
  'welcome.title': 'Bem-vindo ao Argos',
  'welcome.body': 'Um espaço de trabalho para o Claude Code, o Codex e o Antigravity: os respetivos terminais, os seus projetos, a utilização e os anfitriões remotos/WSL, tudo num só lugar.',
  'welcome.getStarted': 'Começar',
  'connect.title': 'Ligue a sua conta',
  'connect.detected': 'Foi detetado um início de sessão do Claude Code nesta máquina.',
  'connect.notDetected': 'Ainda não foi encontrado nenhum início de sessão do Claude Code.',
  'connect.useClaudeCode': 'Utilizar a minha conta Claude Code',
  'connect.detectedChip': 'Detetado',
  'connect.claudeCodeDesc': 'Os terminais e as tarefas em segundo plano reutilizam o início de sessão da CLI, sem necessidade de chave de API.',
  'connect.claudeCodeHint': 'Execute `claude` uma vez e inicie sessão; depois clique em Verificar novamente.',
  'connect.useApiKey': 'Utilizar uma chave de API',
  'connect.savedChip': 'Guardada',
  'connect.apiKeyDesc': 'Guardada encriptada no porta-chaves do sistema operativo. Os terminais e as tarefas em segundo plano (standup, assistente do planeador) utilizam-na.',
  'connect.recheck': 'Verificar novamente',
  'connect.skip': 'Ignorar',
  'connect.start': 'Começar a utilizar o Argos',
  'connect.continue': 'Ligue-se para continuar'
}

export default onboarding
