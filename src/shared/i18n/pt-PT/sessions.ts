import type en from '../en/sessions'

const sessions: Record<keyof typeof en, string> = {
  'sort.date': 'Mais recentes primeiro',
  'sort.title': 'Título',
  'sort.size': 'Mais longas primeiro',

  'groups.today': 'Hoje',
  'groups.yesterday': 'Ontem',
  'groups.last7': 'Últimos 7 dias',
  'groups.last30': 'Últimos 30 dias',
  'groups.older': 'Mais antigas',

  'tags.title': 'Etiquetas',
  'tags.done': 'Feito',
  'tags.empty': 'Ainda não há etiquetas.',
  'tags.add': 'Adicionar uma etiqueta',
  'tags.remove': 'Remover {tag}',
  'tags.notFound': 'Esta conversa já não está no disco.',

  'peek.label': 'Detalhes da sessão',
  'peek.today': 'hoje às {time}',
  'peek.yesterday': 'ontem às {time}',
  'peek.dateTime': '{date} {time}',
  'peek.msgs': '{n} msgs',
  'peek.notFound': 'Esta conversa já não está no disco.',
  'peek.exists': 'Já existe uma conversa com o mesmo id.',
  'peek.addTag': '+ etiqueta',
  'peek.reading': 'A ler…',
  'peek.nothing': 'Nada a mostrar para esta sessão.',
  'peek.startedWith': 'Começou com',
  'peek.leftOffAt': 'Parou em',
  'peek.newName': 'Novo nome',
  'peek.renameNote': 'O nome é guardado dentro da conversa, por isso o Claude Code também o vê.',
  'peek.renameNoteCodex': 'O nome vai para o índice de sessões do próprio Codex, por isso a CLI do Codex também o vê.',
  'peek.renameHint': 'Enter muda o nome · Esc cancela',
  'peek.moveTo': 'Mover para o projeto',
  'peek.pickProject': 'Escolhe um projeto',
  'peek.moveNote':
    'Apenas organização. O local onde a conversa foi executada fica registado nela e nunca é reescrito, por isso ao retomá-la abre na pasta certa.',
  'peek.moveNoteCodex':
    'O Codex arquiva uma conversa pela pasta registada nela, por isso mover reescreve essa pasta: retomar esta conversa inicia-a no novo projeto.',
  'peek.moveHint': 'Enter move · Esc cancela',
  'peek.move': 'Mover',
  'peek.deleteConfirm':
    'Eliminar esta conversa e as suas {n} mensagens? Arquivar mantém-na e retira-a da lista.',
  'peek.deleteUndone': 'Esta ação não pode ser anulada.',
  'peek.deleteHint': 'Enter elimina · Esc mantém',
  'peek.keep': 'Manter',
  'peek.notResumable': 'Escrita pelo Codex: a CLI do Claude Code não a consegue retomar',
  'peek.resume': 'Retomar',
  'peek.archive': 'Arquivar',
  'peek.unarchive': 'Desarquivar',

  'activity.label': 'Atividade',
  'activity.loading': 'A carregar…',
  'activity.run': 'Execução',
  'activity.report': 'Relatório',
  'activity.noCalls': 'Ainda sem chamadas. O modelo lê primeiro o runbook.',
  'activity.calls.one': '{n} chamada',
  'activity.calls.other': '{n} chamadas',

  'activity.run.runningSince': 'Em execução desde {time}',
  'activity.run.stopped': 'Parou',
  'activity.run.finished': 'Terminou às {time}',
  'activity.run.starting': 'A iniciar a execução…',
  'activity.run.steps.one': '{done} de {n} passo',
  'activity.run.steps.other': '{done} de {n} passos',
  'activity.run.stop': 'Parar',
  'activity.run.endTitle':
    'Terminar esta intervenção: as chamadas pendentes são recusadas, a CLI é fechada e regressas ao Ops',
  'activity.run.stopTitle':
    'Parar esta execução: as chamadas pendentes são recusadas e as ferramentas de ops da CLI deixam de funcionar',

  'activity.earlier.notClosed': 'não fechou',
  'activity.earlier.stopped': 'parou',
  'activity.earlier.finished': 'terminou',
  'activity.earlier.failed': 'falhou',
  'activity.earlier.title.one': 'Hoje, mais cedo · {n} execução',
  'activity.earlier.title.other': 'Hoje, mais cedo · {n} execuções',
  'activity.earlier.line': '{time} · {state} · {calls}',

  'activity.section.output': 'saída',
  'activity.section.noOutput': '(sem saída)',
  'activity.section.collapseAll': 'Recolher tudo',
  'activity.section.expandAll': 'Expandir tudo',

  'activity.step.running': '{calls} · em execução',
  'activity.step.notAllowed': '{n} sem permissão',
  'activity.step.failed': '{n} com falha',

  'activity.drawer.label': 'Script {name}',
  'activity.drawer.back': 'Voltar',
  'activity.drawer.noHost': 'sem anfitrião',
  'activity.drawer.hash': 'sha256 {hash} (corresponde ao hash fixado na política)',

  'activity.scripts.title': 'Scripts',
  'activity.scripts.changesHost': 'altera o anfitrião',
  'activity.scripts.noHostTip': 'Nenhum anfitrião desta intervenção está nos grupos de anfitriões do script',
  'activity.scripts.tip': '{title}\n{name} · {class} · {hosts}\nClica para pedir ao modelo que o execute',
  'activity.scripts.view': 'Ver {name}',
  'activity.scripts.viewTitle': 'Ver o script',
  'activity.scripts.hostFor': 'Anfitrião para {name}',
  'activity.scripts.args': 'argumentos (até {n})',
  'activity.scripts.runOn': 'Executar em {host}?',

  'activity.host.allowed': 'Anfitrião {host} permitido às {time}',
  'activity.host.refused': 'Anfitrião {host} recusado às {time}',

  'activity.wait.eyebrow': 'À tua espera',
  'activity.wait.newHost': 'novo anfitrião',
  'activity.wait.reach': 'O modelo quer aceder a {host}. Permitir para esta intervenção?',
  'activity.wait.allow': 'Permitir',
  'activity.wait.deny': 'Recusar',
  'activity.wait.changesHost': 'altera o anfitrião',
  'activity.wait.read': 'leitura',
  'activity.wait.queued.one': 'Em fila atrás de {n} chamada em {host}.',
  'activity.wait.queued.other': 'Em fila atrás de {n} chamadas em {host}.',
  'activity.wait.denyStop': 'Recusar e parar'
}

export default sessions
