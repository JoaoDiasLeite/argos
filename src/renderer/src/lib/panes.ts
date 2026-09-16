// Modelo de estado dos painéis (split/grid) e as funções puras que o manipulam.
//
// Fica de propósito sem React, sem DOM e sem localStorage: quem persiste e quem
// liga isto à UI vive noutro ficheiro (o hook `usePanes`, ainda por escrever),
// para que este módulo se possa testar e raciocinar sobre ele sem montar nada.

export type LayoutId = 'single' | 'cols-2' | 'cols-3' | 'grid-2x2' | 'main-side'

export interface Pane {
  sessionId: string
  /** Reservado: override do modo por painel. Não usado ainda — existe para evitar
   *  migrar a chave persistida quando quisermos um chat ao lado de um terminal. */
  mode?: 'chat' | 'terminal'
}

export interface PaneState {
  v: 1
  layout: LayoutId
  /** Invariante: sessionId único em todos os painéis; length <= capacity(layout). */
  panes: Pane[]
  /** sessionId do painel focado; '' quando não há painéis. */
  focused: string
  /** Fracções por eixo, normalizadas para somar 1. Ausente = painéis iguais. */
  sizes?: { cols?: number[]; rows?: number[] }
}

// Ordem de "subida" de layout usada por openInNewPane — não é a ordem de capacidade
// pura (grid-2x2 e main-side empatam a 4/3... na verdade main-side fica de fora
// porque não é um degrau automático, é uma escolha explícita do utilizador).
const CAPACITY: Record<LayoutId, number> = {
  single: 1,
  'cols-2': 2,
  'cols-3': 3,
  'grid-2x2': 4,
  'main-side': 3
}

// Degraus que openInNewPane sobe sozinho quando fica sem espaço. main-side não
// entra aqui: também cabe 3 painéis como cols-3, mas é um layout com forma própria
// (um painel grande + coluna lateral) que só faz sentido por escolha explícita.
const AUTO_GROW: LayoutId[] = ['single', 'cols-2', 'cols-3', 'grid-2x2']

export function capacity(layout: LayoutId): number {
  return CAPACITY[layout]
}

export function emptyState(): PaneState {
  return { v: 1, layout: 'single', panes: [], focused: '' }
}

export function openInFocused(state: PaneState, sessionId: string): PaneState {
  // Regra 1: sessionId vazio é o sinal de "fecha tudo", não uma sessão real.
  if (sessionId === '') {
    return { ...state, panes: [], focused: '' }
  }

  const existingIndex = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (existingIndex !== -1) {
    // Regra 2: já está aberta noutro painel — não duplicar, só focar.
    return { ...state, focused: sessionId }
  }

  if (state.panes.length === 0) {
    // Regra 3: sem painéis, este é o primeiro.
    return { ...state, panes: [{ sessionId }], focused: sessionId }
  }

  // Regra 4: substitui a sessão do painel focado, preservando a posição dele.
  const focusedIndex = state.panes.findIndex((p) => p.sessionId === state.focused)
  const targetIndex = focusedIndex === -1 ? 0 : focusedIndex
  const panes = state.panes.map((p, i) => (i === targetIndex ? { ...p, sessionId } : p))
  return { ...state, panes, focused: sessionId }
}

export function openInNewPane(state: PaneState, sessionId: string): PaneState {
  const existingIndex = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (existingIndex !== -1) {
    // Mesma regra de não-duplicação que openInFocused: mover o foco chega.
    return { ...state, focused: sessionId }
  }

  const cap = capacity(state.layout)
  if (state.panes.length < cap) {
    return { ...state, panes: [...state.panes, { sessionId }], focused: sessionId }
  }

  // Sem espaço no layout atual: tenta subir um degrau em vez de sacrificar um
  // painel existente — é o que o utilizador espera de "abrir num painel novo".
  const step = AUTO_GROW.indexOf(state.layout)
  const nextLayout = step !== -1 && step + 1 < AUTO_GROW.length ? AUTO_GROW[step + 1] : null
  if (nextLayout) {
    return {
      ...state,
      layout: nextLayout,
      panes: [...state.panes, { sessionId }],
      focused: sessionId
    }
  }

  // Já no máximo (ou num layout sem degrau seguinte, como main-side): não há para
  // onde crescer, cai para o mesmo comportamento de openInFocused.
  return openInFocused(state, sessionId)
}

export function closePane(state: PaneState, sessionId: string): PaneState {
  const index = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (index === -1) {
    return state
  }

  const panes = state.panes.filter((_, i) => i !== index)

  if (panes.length === 0) {
    // Volta a single: não há painéis para justificar um layout maior.
    return { ...state, panes, focused: '', layout: 'single' }
  }

  if (state.focused !== sessionId) {
    // O foco não estava aqui, não há nada a recalcular.
    return { ...state, panes }
  }

  // O painel adjacente é o anterior ao removido, ou o primeiro se era o índice 0.
  const adjacentIndex = index === 0 ? 0 : index - 1
  return { ...state, panes, focused: panes[adjacentIndex].sessionId }
}

export function setFocus(state: PaneState, sessionId: string): PaneState {
  const isOpen = state.panes.some((p) => p.sessionId === sessionId)
  if (!isOpen) {
    return state
  }
  return { ...state, focused: sessionId }
}

export function setLayout(state: PaneState, layout: LayoutId): PaneState {
  const cap = capacity(layout)
  if (state.panes.length <= cap) {
    return { ...state, layout }
  }

  const focusedIndex = state.panes.findIndex((p) => p.sessionId === state.focused)
  let panes: Pane[]
  if (focusedIndex !== -1 && focusedIndex >= cap) {
    // O corte simples deixaria o painel focado de fora — troca-o com o último
    // painel que sobrevive ao corte para que continue visível.
    panes = state.panes.slice(0, cap)
    panes[cap - 1] = state.panes[focusedIndex]
  } else {
    panes = state.panes.slice(0, cap)
  }

  const focused = panes.some((p) => p.sessionId === state.focused)
    ? state.focused
    : panes[0].sessionId

  return { ...state, layout, panes, focused }
}

export function normalize(state: unknown, knownSessionIds: string[]): PaneState {
  // Vem do localStorage: trata tudo como potencialmente hostil e nunca atira.
  if (typeof state !== 'object' || state === null) {
    return emptyState()
  }

  const raw = state as Partial<PaneState>
  const layout: LayoutId = CAPACITY[raw.layout as LayoutId] ? (raw.layout as LayoutId) : 'single'
  const known = new Set(knownSessionIds)

  const rawPanes = Array.isArray(raw.panes) ? raw.panes : []
  const seen = new Set<string>()
  const panes: Pane[] = []
  for (const entry of rawPanes) {
    const sessionId = (entry as Partial<Pane> | null)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (!known.has(sessionId)) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    panes.push({ sessionId })
    if (panes.length >= capacity(layout)) break
  }

  if (panes.length === 0) {
    return emptyState()
  }

  const focused =
    typeof raw.focused === 'string' && panes.some((p) => p.sessionId === raw.focused)
      ? raw.focused
      : panes[0].sessionId

  return { v: 1, layout, panes, focused }
}
