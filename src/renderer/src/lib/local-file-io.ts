// Local-fs read/write pair for FileEditor, shared by every view that opens a file from
// the machine's own disk (sidebar Files tab, WSL "Connect" LocalBrowser). Kept as thin
// wrappers so callers don't each re-derive the read shape FileEditor expects.
export function readLocalFile(filePath: string): Promise<{
  ok: boolean
  content?: string
  tooLarge?: boolean
  binary?: boolean
  error?: string
}> {
  return window.electronAPI.fsReadText(filePath)
}

export function writeLocalFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  return window.electronAPI.fsWriteFile(filePath, content)
}
