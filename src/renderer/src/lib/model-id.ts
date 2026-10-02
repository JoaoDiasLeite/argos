/**
 * A model as a short id for a chip: `claude-opus-5-20260101` reads `opus-5`. The vendor
 * prefix is on every row, and the date stamp tells nobody anything.
 */
export function shortModel(model?: string): string {
  if (!model) return ''
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
