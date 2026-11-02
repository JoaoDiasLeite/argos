import type en from '../en/companion'

const companion: Record<keyof typeof en, string> = {
  'pet.label': 'Argos. Clica para escrever, arrasta para mover.',

  'day.today': 'Hoje',
  'day.tomorrow': 'Amanhã',
  'day.yesterday': 'Ontem',
  'dayInline.today': 'hoje',
  'dayInline.tomorrow': 'amanhã',
  'dayInline.yesterday': 'ontem',
  'when.dayAt': '{day} às {time}',
  'when.dayTime': '{day}, {time}',
  'span.min': '{n} min',
  'span.hour': '{n} h',
  'span.day': '{n} d',

  'input.label': 'Escreve uma tarefa ou uma nota',
  'input.placeholder': 'O que precisas?',
  'input.help': 'Enter guarda · Esc fecha',
  'needsTitle.question': 'O que é para {when}?',

  'receipt.saved': 'Guardado',
  'receipt.savedNoDate': 'Guardado sem data',
  'receipt.noteSaved': 'Nota guardada',
  'receipt.reminder': 'aviso',
  'receipt.reminderAt': 'aviso às {time}',
  'receipt.edit': 'Editar',
  'receipt.setDate': 'Definir data',
  'receipt.undo': 'Desfazer',
  'receipt.undone': 'Desfeito',

  'query.title': 'Na lista',
  'query.range': '{from} a {to}',
  'query.empty': 'Nada na lista para isso.',

  'reminder.late': 'atrasado {span}',
  'reminder.done': 'Feito',
  'reminder.snooze10': '+10 min',
  'reminder.snoozeMore': 'Mais formas de adiar',
  'reminder.open': 'Abrir',
  'reminder.help': 'Enter marca como feito · Esc fecha',
  'reminder.queued.one': 'mais 1 à espera',
  'reminder.queued.other': 'mais {n} à espera',
  'snooze.10m': '10 minutos',
  'snooze.1h': '1 hora',
  'snooze.tomorrow': 'Amanhã de manhã',
  'snooze.pick': 'Escolher…',
  'snooze.pickLabel': 'Adiar até',
  'snooze.ok': 'OK',

  'catchup.title.one': '1 lembrete passou',
  'catchup.title.other': '{n} lembretes passaram',
  'catchup.launch': 'enquanto o Argos esteve fechado',
  'catchup.dnd': 'enquanto estavas em silêncio',
  'catchup.toggle': 'Mostrar ou esconder a lista',
  'catchup.markDone': 'Marcar "{title}" como feito',
  'catchup.seeAll': 'Ver todos'
}

export default companion
