// The stored name of a chat nobody has named yet.
//
// It is persisted as the literal 'New chat' and compared against in several places (a
// transcript title or search hit may replace it), so it must not change with the UI
// language. What changes is how it is shown: every place that prints a chat's name goes
// through chatDisplayName, which swaps the sentinel (or an empty name) for the
// translated label.
import type { TFunction } from '../../../shared/i18n'

export const NEW_CHAT_NAME = 'New chat'

export function isUnnamedChat(name: string | undefined | null): boolean {
  return !name || name === NEW_CHAT_NAME
}

export function chatDisplayName(name: string | undefined | null, t: TFunction): string {
  return isUnnamedChat(name) ? t('sidebar.session.newChat') : (name as string)
}
