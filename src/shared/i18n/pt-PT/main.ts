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
    'A aplicação continua em execução na área de notificação. Utilize o ícone para a reabrir ou para sair.',

  'sshTrust.storeUnreadable': 'Não foi possível ler o registo de confiança SSH. Ligação recusada.',
  'sshTrust.changed.title': 'A chave do anfitrião SSH foi alterada',
  'sshTrust.changed.message': 'A ligação a {endpoint} foi recusada.',
  'sshTrust.changed.detail':
    'Confiável: {known}\nRecebida: {fingerprint}\nConfirme a identidade do servidor junto do respetivo administrador antes de alterar a confiança.',
  'sshTrust.verify.title': 'Verificar o servidor SSH',
  'sshTrust.verify.message': 'Confiar em {endpoint}?',
  'sshTrust.verify.detail':
    'Impressão digital do servidor:\n{fingerprint}\nCompare-a com a impressão digital fornecida pelo administrador do servidor.',
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
  'planUsage.reset.minutes': 'reinicia dentro de {m} min',
  'planUsage.reset.hours': 'reinicia dentro de {h} h {m} min'
}

export default main
