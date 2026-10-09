import type en from '../en/accounts'

const accounts: Record<keyof typeof en, string> = {
  // Accounts modal
  'modal.title': 'Contas',
  'row.nameAria': 'Nome da conta',
  'row.default': 'Predefinida',
  'row.relogin': 'Reautenticar',
  'row.login': 'Iniciar sessão',
  'row.setDefault': 'Predefinir',
  'row.remove': 'Remover',
  'status.loggedIn': 'Sessão iniciada',
  'status.runLogin': 'Inicie sessão para autenticar esta conta',
  'login.title': 'Concluir o início de sessão',
  'login.hint': 'Deve ter-se aberto um terminal. Conclua o início de sessão no navegador e depois atualize. Se não se abriu nenhum terminal, execute este comando manualmente:',
  'login.refresh': 'Atualizar estado',
  'login.dismiss': 'Dispensar',
  'add.button': 'Adicionar e iniciar sessão',
  'claude.intro': 'Cada conta é um início de sessão separado do Claude Code. Mude a conta ativa no seletor de contas da barra lateral; os novos chats utilizam a conta selecionada.',
  'claude.usesMachineLogin': 'Utiliza o início de sessão do Claude Code desta máquina',
  'claude.newName': 'Nome da nova conta (p. ex. Trabalho, Pessoal)',
  'provider.intro': 'Cada conta é um início de sessão separado do {provider}. Mude a conta ativa no seletor de contas da barra lateral quando estiver selecionado um modelo {provider}.',
  'provider.usesMachineLogin': 'Utiliza o início de sessão da CLI do {provider} desta máquina',
  'provider.newName': 'Nome da nova conta {provider} (p. ex. Trabalho, Pessoal)',
  'antigravity.intro': 'Os modelos Gemini são executados através do Antigravity, a CLI agêntica da Google, iniciada com {cmd}. Utiliza um único início de sessão para toda a máquina, guardado no porta-chaves do sistema operativo, por isso existe apenas uma conta.',
  'antigravity.meta': 'Início de sessão único da máquina via agy, guardado no porta-chaves do sistema',
  'antigravity.loginHint': 'Iniciar sessão abre o Antigravity num terminal. Conclua aí o início de sessão na Google.',

  // Account picker
  'picker.title': 'Conta para este chat',
  'picker.fallback': 'Conta',
  'picker.notLoggedIn': 'Sem sessão iniciada',
  'picker.manage': 'Gerir contas',

  // Model picker
  'model.new': 'novo',
  'model.discoveredTitle': 'Detetado por descoberta em direto: ainda não está no catálogo incluído',
  'model.discoveredMeta': 'novo: preços ainda não catalogados',
  'model.discoveredMetaCtx': '{context} · novo: preços ainda não catalogados',
  'model.comingSoon': 'Em breve',
  'model.price': '{context} · ${input}/${output} por Mtok'
}

export default accounts
