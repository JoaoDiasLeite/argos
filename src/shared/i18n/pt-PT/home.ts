import type en from '../en/home'

const home: Record<keyof typeof en, string> = {
  'time.justNow': 'agora mesmo',
  'time.minutesAgo': 'há {n} min',
  'time.hoursAgo': 'há {n} h',
  'time.daysAgo': 'há {n} d',

  'duration.lessThanMinute': '<1 min',
  'duration.minutes': '{n} min',
  'duration.hoursMinutes': '{h} h {m} min',
  'duration.hours': '{h} h',
  'duration.days': '{n} d',

  'header.dayTitle': '{weekday}, {day} de {month}',

  'plan.window.default': 'janela do plano',
  'plan.window.weekly': 'janela semanal',
  'plan.window.hours': 'janela de {n} horas',
  'plan.window.days': 'janela de {n} dias',
  'plan.resets': 'reinicia às {time}',
  'plan.resetsOn': 'reinicia {day} às {time}',
  'plan.noAccount': 'Nenhuma conta ligada · Definições › Ligação',
  'plan.account': 'Conta {name}',
  'plan.usage': 'Conta {name} a {pct}% da {window}',
  'plan.usageWithReset': '{usage} · {reset}',
  'plan.label': 'Janela do plano',
  'plan.title': '{name} · {window}',
  'plan.pct': '{pct}%',
  'plan.pctWithReset': '{pct}% · {reset}',
  'plan.barLabel': '{pct}% da janela utilizada',

  'select.empty': 'Ainda nada',

  'start.prompt': 'O que vamos fazer?',
  'start.project': 'Projeto',
  'start.cli': 'CLI',
  'start.account': 'Conta',
  'start.newProject': 'Novo projeto',
  'start.submit': 'Iniciar',
  'start.hint': 'Ctrl+Enter inicia num novo terminal · a pasta é a raiz do projeto',

  'body.empty': 'Nada em execução, nada à espera. Comece algo acima.',

  'recent.title': 'Continue onde parou',
  'recent.showMore': 'Mostrar mais {n}',

  'projects.title': 'Projetos recentes',
  'projects.readingGit': 'A ler o estado do git',
  'projects.noGit': 'sem git',

  'side.label': 'O que está ativo',

  'needs.label': 'Precisa de si',
  'needs.title': 'Precisa de si · {n}',
  'needs.none': 'Nada à sua espera.',
  'needs.oldest': 'o mais antigo há {time}',

  'running.label': 'Em execução',
  'running.title': 'Em execução · {n}',
  'running.none': 'Nada em execução.',
  'running.group.chats': 'Chats',
  'running.group.servers': 'Servidores',
  'running.group.interventions': 'Intervenções',

  'repos.label': 'Alterações por commit',
  'repos.title': 'Alterações por commit · {n}',
  'repos.clean': 'Todos os repositórios recentes estão limpos.',
  'repos.counting': 'A contar alterações',
  'repos.files.one': '{n} ficheiro',
  'repos.files.other': '{n} ficheiros'
}

export default home
