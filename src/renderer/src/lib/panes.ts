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
    // O número de painéis muda: as fracções de coluna guardadas já não descrevem
    // este layout, não faz sentido tentar reescalá-las (ver comentário em dropAxis).
    return dropAxis({ ...state, panes: [...state.panes, { sessionId }], focused: sessionId }, 'cols')
  }

  // Sem espaço no layout atual: tenta subir um degrau em vez de sacrificar um
  // painel existente — é o que o utilizador espera de "abrir num painel novo".
  const step = AUTO_GROW.indexOf(state.layout)
  const nextLayout = step !== -1 && step + 1 < AUTO_GROW.length ? AUTO_GROW[step + 1] : null
  if (nextLayout) {
    return dropAxis(
      {
        ...state,
        layout: nextLayout,
        panes: [...state.panes, { sessionId }],
        focused: sessionId
      },
      'cols'
    )
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
    return dropAxis({ ...state, panes, focused: '', layout: 'single' }, 'cols')
  }

  if (state.focused !== sessionId) {
    // O foco não estava aqui, não há nada a recalcular — mas o número de painéis
    // mudou na mesma, e com ele o número de colunas.
    return dropAxis({ ...state, panes }, 'cols')
  }

  // O painel adjacente é o anterior ao removido, ou o primeiro se era o índice 0.
  const adjacentIndex = index === 0 ? 0 : index - 1
  return dropAxis({ ...state, panes, focused: panes[adjacentIndex].sessionId }, 'cols')
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
    // O número de painéis visíveis não muda (só pode crescer o layout à volta
    // deles), por isso as fracções de coluna continuam a descrever o mesmo
    // número de painéis e não há razão para as descartar.
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

  // Aqui sim o número de painéis muda (corte): as fracções antigas já não
  // correspondem ao número de colunas do novo layout.
  return dropAxis({ ...state, layout, panes, focused }, 'cols')
}

// Descarta um eixo de `sizes` (imutável): usado sempre que uma transição muda o
// número de painéis desse eixo, porque nesse caso as fracções antigas já não
// descrevem o layout novo — reescalá-las daria tamanhos que ninguém escolheu.
function dropAxis(state: PaneState, axis: keyof NonNullable<PaneState['sizes']>): PaneState {
  if (!state.sizes || !(axis in state.sizes)) return state
  const rest = { ...state.sizes }
  delete rest[axis]
  if (Object.keys(rest).length === 0) {
    const { sizes: _sizes, ...withoutSizes } = state
    return withoutSizes
  }
  return { ...state, sizes: rest }
}

/** Um eixo válido: só números finitos, todos > 0, com o comprimento certo. */
function isValidAxis(value: unknown, expectedLength: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
  )
}

/** Normaliza a soma de um eixo para 1, preservando as proporções relativas. */
function normalizeAxis(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  return values.map((n) => n / sum)
}

/**
 * Puro e imutável: define/substitui as fracções de um ou ambos os eixos. Cada
 * eixo passado é renormalizado para somar 1; um eixo vazio ou ausente é
 * removido em vez de guardado como `[]`, para que `normalize` não tenha de
 * distinguir "sem eixo" de "eixo vazio" ao restaurar.
 */
export function setSizes(
  state: PaneState,
  sizes: { cols?: number[]; rows?: number[] }
): PaneState {
  const cols = sizes.cols && sizes.cols.length > 0 ? normalizeAxis(sizes.cols) : undefined
  const rows = sizes.rows && sizes.rows.length > 0 ? normalizeAxis(sizes.rows) : undefined
  const next: NonNullable<PaneState['sizes']> = {
    ...(cols ? { cols } : {}),
    ...(rows ? { rows } : {})
  }
  if (Object.keys(next).length === 0) {
    const { sizes: _sizes, ...withoutSizes } = state
    return withoutSizes
  }
  return { ...state, sizes: next }
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

  // O eixo só é aceite se bater certo com o número de painéis *depois* do
  // saneamento acima (dedup, sessões desconhecidas, corte pela capacidade) —
  // validar contra o `raw.panes.length` original deixaria passar um eixo
  // desalinhado sempre que o saneamento tivesse descartado alguma entrada.
  // Quando não bate, descarta-se o eixo em vez de tentar adivinhar: volta a
  // painéis iguais, que é o comportamento seguro por omissão.
  const rawSizes = raw.sizes as Partial<{ cols: unknown; rows: unknown }> | null | undefined
  let sizes: PaneState['sizes'] | undefined
  if (rawSizes && typeof rawSizes === 'object') {
    const cols = isValidAxis(rawSizes.cols, panes.length)
      ? normalizeAxis(rawSizes.cols)
      : undefined
    const rows = isValidAxis(rawSizes.rows, panes.length)
      ? normalizeAxis(rawSizes.rows)
      : undefined
    if (cols || rows) {
      sizes = { ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) }
    }
  }

  return sizes ? { v: 1, layout, panes, focused, sizes } : { v: 1, layout, panes, focused }
}
