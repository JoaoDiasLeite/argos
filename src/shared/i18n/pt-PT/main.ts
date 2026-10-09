import type en from '../en/main'

const main: Record<keyof typeof en, string> = {
  'tray.open': 'Abrir o Argos',
  'tray.newTerminal': 'Novo terminal',
  'tray.quickLauncher': 'Lançador rápido',
  'tray.quickLauncherWithShortcut': 'Lançador rápido ({shortcut})',
  'tray.quit': 'Sair do Argos',

  'menu.view': 'Ver',
  'menu.window': 'Janela',
  'menu.reload': 'Recarregar',
  'menu.forceReload': 'Forçar recarregamento',
  'menu.toggleDevTools': 'Ferramentas de programador',
  'menu.resetZoom': 'Tamanho real',
  'menu.zoomIn': 'Aumentar zoom',
  'menu.zoomOut': 'Reduzir zoom',
  'menu.minimize': 'Minimizar',
  'menu.close': 'Fechar',

  'notify.trayHint.title': 'O Argos continua em execução',
  'notify.trayHint.body':
    'A aplicação continua em execução na área de notificação. Utiliza o ícone para a reabrir ou para sair.',

  'sshTrust.storeUnreadable': 'Não foi possível ler o registo de confiança SSH. Ligação recusada.',
  'sshTrust.changed.title': 'A chave do anfitrião SSH foi alterada',
  'sshTrust.changed.message': 'A ligação a {endpoint} foi recusada.',
  'sshTrust.changed.detail':
    'Confiável: {known}\nRecebida: {fingerprint}\nConfirma a identidade do servidor junto do respetivo administrador antes de alterar a confiança.',
  'sshTrust.verify.title': 'Verificar o servidor SSH',
  'sshTrust.verify.message': 'Confiar em {endpoint}?',
  'sshTrust.verify.detail':
    'Impressão digital do servidor:\n{fingerprint}\nCompara-a com a impressão digital fornecida pelo administrador do servidor.',
  'sshTrust.verify.trust': 'Confiar neste servidor',

  'planUsage.window.session': 'Sessão (5h)',
  'planUsage.window.weekAll': 'Semana · todos os modelos',
  'planUsage.window.weekOpus': 'Semana · Opus',
  'planUsage.window.weekSonnet': 'Semana · Sonnet',
  'planUsage.short.session': 'Sessão',
  'planUsage.short.week': 'Semana',
  'planUsage.tooltip': 'Argos · {parts}',
  'planUsage.tooltip.part': '{window} {pct}%',
  'planUsage.alert.title': 'Aviso de limite do plano: {account}',
  'planUsage.alert.body': '{window}: {pct}% utilizados',
  'planUsage.alert.bodyWithReset': '{window}: {pct}% utilizados · {reset}',
  'planUsage.reset.soon': 'reinicia em breve',
  'planUsage.reset.minutes': 'reinicia em {m} min',
  'planUsage.reset.hours': 'reinicia em {h} h {m} min',

  'taskbar.runFinished': 'Execução terminada',
  'taskbar.runFailed': 'A execução falhou',
  'taskbar.approvalNeeded': 'Aprovação necessária',

  'ipc.ops.noRunbookFolder': 'Não foi indicada nenhuma pasta de runbook.',
  'ipc.ops.notRunbookFile': 'Não é um ficheiro do runbook: {name}',
  'ipc.ops.noRunId': 'Não foi indicado nenhum id de execução.',
  'ipc.ops.invalidRunId': 'Id de execução inválido.',
  'ipc.ops.unknownReportKind': 'Tipo de relatório desconhecido: {kind}',
  'ipc.ops.reportHostsAnonymised':
    'Não foi possível carregar o runbook, por isso os anfitriões aparecem como [servidor]: {error}',
  'ipc.ops.saveRunbookUnloadable': 'Não foi possível carregar o runbook, por isso nada foi guardado: {error}',
  'ipc.ops.reportExists': 'Já existe um relatório em {file}; não foi substituído.',
  'ipc.ops.reportSaveFailed': 'Não foi possível guardar o relatório: {error}',
  'ipc.ops.noSessionId': 'Não foi indicado nenhum id de sessão.',
  'ipc.ops.noIntervention': 'Não foi indicada nenhuma intervenção.',
  'ipc.ops.interventionNoServer': 'A intervenção não indica nenhum servidor.',
  'ipc.ops.interventionNoTask': 'A intervenção não tem tarefa.',
  'ipc.ops.bridgeFailed': 'Não foi possível iniciar a ponte de ops: {error}',
  'ipc.ops.noLiveSession': 'Não há nenhuma sessão de ops ativa neste terminal.',
  'ipc.ops.scriptNameRequired': 'É necessário o nome de um script.',
  'ipc.ops.scriptAndHostRequired': 'São necessários o nome de um script e um anfitrião.',
  'ipc.ops.invalidTerminalId': 'Id de terminal inválido.',
  'ipc.prompts.invalidSessionId': 'Id de sessão inválido.',
  'ipc.prompts.textInvalid': 'O texto do prompt está em falta ou é demasiado longo.',
  'ipc.ai.modelError': 'O modelo devolveu um erro.',
  'ipc.ai.unparsableJson': 'Não foi possível interpretar a resposta do modelo como JSON.',
  'ipc.ai.noForgeMcp':
    'Não foi encontrado nenhum servidor MCP do GitLab ou do GitHub (verificados local e WSL). Configura um na CLI e tenta novamente.',
  'ipc.ai.wslBackfillFailed': 'A execução de preenchimento no WSL falhou.',
  'ipc.exports.notChatExport': 'Não é uma exportação de chat.',
  'ipc.exports.fileGone': 'O ficheiro já não existe.',

  'config.settingsReadFailed': 'Não foi possível ler o settings.json: {error}',
  'config.settingsUnparsable':
    'O ~/.claude/settings.json existe, mas não foi possível interpretá-lo (pode ter comentários ou estar mal formado). Corrige-o manualmente antes de guardar a partir daqui.',
  'config.settingsWriteFailed': 'Não foi possível escrever o settings.json: {error}',
  'config.permissions.notObject': 'As permissões têm de ser um objeto',
  'config.permissions.notArray': 'permissions.{key} tem de ser uma lista',
  'config.permissions.itemNotString': 'permissions.{key}[{i}] tem de ser texto',
  'config.hooks.notObject': 'Os hooks têm de ser um objeto',
  'config.hooks.eventNotArray': 'hooks.{event} tem de ser uma lista',
  'config.hooks.entryNotObject': 'hooks.{event}[{i}] tem de ser um objeto',
  'config.hooks.entryHooksNotArray': 'hooks.{event}[{i}].hooks tem de ser uma lista',
  'config.hooks.hookNotObject': 'hooks.{event}[{i}].hooks[{j}] tem de ser um objeto',
  'config.hooks.commandEmpty': 'hooks.{event}[{i}].hooks[{j}].command tem de ser texto não vazio',

  'sessions.codex.unrecognisedName': 'Esta transcrição tem um nome não reconhecido.',
  'sessions.codex.noHeader':
    'Esta transcrição não tem um cabeçalho que diga onde foi executada, por isso não pode ser reclassificada.',
  'sessions.codex.noProjectDir': 'O Codex não tem uma pasta de projeto para onde mover uma conversa do Claude Code.',

  'files.invalidPath': 'Caminho inválido',
  'files.invalidContent': 'Conteúdo inválido',
  'files.refuseRootDelete': 'Não é permitido eliminar a raiz de um sistema de ficheiros',
  'files.noHomeDir': 'Não foi possível determinar a pasta pessoal',

  'sftp.invalidRemotePath': 'Caminho remoto inválido',
  'sftp.fileNotFound': 'Ficheiro não encontrado',
  'sftp.dirMayNotBeEmpty': '{error} (a pasta pode não estar vazia)',
  'sftp.dialog.save': 'Guardar ficheiro',
  'sftp.dialog.upload': 'Carregar ficheiros',
  'sftp.uploadFailed': 'O carregamento falhou: {names}',

  'ssh.hostNotFound': 'Anfitrião não encontrado',
  'ssh.connectedAs': 'Ligado como {user}@{host}:{port} em {ms} ms',
  'ssh.connectedBut': 'Ligado, mas: {error}',
  'ssh.claudeNotFound':
    'O claude não foi encontrado neste anfitrião ({path}). Instala-o: npm i -g @anthropic-ai/claude-code',
  'ssh.claudeNoOutput': 'O claude não produziu nenhuma saída',
  'ssh.hostsSaveFailed': 'Não foi possível guardar o ficheiro de anfitriões: {error}',
  'ssh.hostsUnreadable':
    'Não foi possível ler o ficheiro de anfitriões guardado ({error}); não vai ser substituído. Move {file} para outro lado para começar de novo.',
  'ssh.keys.invalidName': 'O nome da chave só pode ter letras, números, "_" e "-".',
  'ssh.keys.exists': 'Já existe uma chave chamada "{name}" em ~/.ssh.',
  'ssh.keys.keygenMissing': 'O ssh-keygen não foi encontrado. Instala o cliente OpenSSH e tenta novamente.',
  'ssh.keys.keygenExit': 'O ssh-keygen terminou com o código {code}.',

  'terminal.invalidId': 'Id de terminal inválido: {id}',
  'terminal.invalidIdShort': 'Id de terminal inválido',
  'terminal.invalidOpsLaunch': 'Arranque de ops inválido para este terminal.',
  'terminal.opsLocalOnly': 'Nesta versão, os terminais de ops correm numa shell local.',
  'terminal.noSshHost': 'Não há nenhum anfitrião SSH guardado com o id {id}; pode ter sido eliminado em Servidores.',
  'terminal.opsConfigUnreadable': 'Não é possível ler a configuração de ops em {path}.',
  'terminal.codexHomeFailed': 'Não foi possível preparar a pasta do Codex para este terminal de ops.',
  'terminal.spawnFailed': 'não foi possível iniciar a shell',

  'wsl.windowsOnly': 'O WSL só está disponível no Windows',
  'wsl.startedAs': 'Iniciado como {who} em {ms} ms',
  'wsl.noResponse': 'A distro não respondeu',
  'wsl.nodeMissing':
    'O Node.js não foi encontrado nesta distro. Instala o Node 18+ e o Claude Code (npm i -g @anthropic-ai/claude-code).',
  'wsl.nodeTooOld':
    'O Node {version} é demasiado antigo: o Claude Code precisa do Node {min}+. Atualiza o Node nesta distro e volta a instalar: npm i -g @anthropic-ai/claude-code',
  'wsl.claudeBroken':
    'O Claude Code não arrancou. Normalmente, isto significa que o Node é demasiado antigo: o Claude Code precisa do Node {min}+.',
  'wsl.claudeBrokenWithNode':
    'O Claude Code não arrancou (Node {version}). Normalmente, isto significa que o Node é demasiado antigo: o Claude Code precisa do Node {min}+.',
  'wsl.claudeNotFound': 'O claude não foi encontrado nesta distro. Instala-o: npm i -g @anthropic-ai/claude-code',
  'wsl.claudeNotFoundShort': 'O claude não foi encontrado nesta distro',
  'wsl.timedOut': 'Expirou ao fim de {s} s',
  'wsl.claudeExited': 'O claude terminou com o código {code}',

  'projects.move.folderFailed': 'não foi possível mover a pasta: {detail}',
  'projects.move.folderRestored': 'a pasta foi reposta onde estava',
  'projects.move.folderNotRestored': 'E NÃO foi possível repor a pasta: está agora em {path} ({detail})',
  'projects.move.transcriptsFailed': 'não foi possível mover as transcrições: {detail}; {restored}',
  'projects.move.claudeJsonNotUpdated': 'o mapa de projetos em {path} não foi atualizado: {error}',
  'projects.prefs.pinned': 'projetos afixados: {error}',
  'projects.prefs.archived': 'projetos arquivados: {error}',
  'projects.prefs.names': 'nomes de projetos: {error}',

  'providers.codex.notFound': 'A CLI do Codex não foi encontrada. Instala com: npm install -g @openai/codex',
  'providers.codex.runFailed': 'A execução do Codex falhou.',
  'providers.codex.error': 'Erro do Codex.',
  'providers.codex.exited': 'O Codex terminou com o código {code}.',
  'providers.codex.textOnly': 'Por agora, o motor do Codex só aceita prompts de texto simples.',
  'providers.gemini.notFound': 'A CLI do Gemini não foi encontrada. Instala com: npm install -g @google/gemini-cli',
  'providers.gemini.error': 'Erro do Gemini.',
  'providers.gemini.exited': 'O Gemini terminou com o código {code}.',
  'providers.gemini.textOnly': 'Por agora, o motor do Gemini só aceita prompts de texto simples.',

  'sessions.title.empty': 'O título não pode estar vazio.',
  'sessions.title.tooLong': 'Mantém o título abaixo de {max} caracteres.',
  'projects.move.alreadyExists': 'já existe: {path}',
  'updater.readyTitle': 'Atualização pronta',
  'updater.readyBody': 'O Argos {version} será instalado no próximo reinício.',
  'jumplist.newTerminal': 'Novo terminal'
}

export default main
