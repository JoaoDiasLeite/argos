import { useState, useEffect } from 'react'
import { FileNode } from '../types'
import './FileTree.css'

interface TreeNodeProps {
  node: FileNode
  depth: number
  onOpenFile?: (path: string) => void
  selectedPath?: string
}

function TreeNode({ node, depth, onOpenFile, selectedPath }: TreeNodeProps) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileNode[]>([])
  const [loaded, setLoaded] = useState(false)

  const toggle = async () => {
    if (node.type === 'directory') {
      if (!loaded) {
        const result = await window.electronAPI.readDir(node.path)
        if (Array.isArray(result)) {
          setChildren(result)
          setLoaded(true)
        }
      }
      setOpen((v) => !v)
    } else {
      onOpenFile?.(node.path)
    }
  }

  const ext = node.name.split('.').pop() ?? ''
  const isDir = node.type === 'directory'
  const active = !isDir && node.path === selectedPath

  return (
    <div>
      <div
        className={`file-node ${isDir ? 'dir' : 'file'} ${active ? 'active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={toggle}
        title={node.path}
      >
        <span className="file-icon">
          {isDir ? (
            open ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            )
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          )}
        </span>
        <span className={`file-name ${getFileClass(ext, isDir)}`}>{node.name}</span>
        {isDir && (
          <span className="chevron" style={{ transform: open ? 'rotate(90deg)' : '' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        )}
      </div>
      {open && children.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} selectedPath={selectedPath} />
      ))}
    </div>
  )
}

function getFileClass(ext: string, isDir: boolean): string {
  if (isDir) return 'color-dir'
  const map: Record<string, string> = {
    ts: 'color-ts', tsx: 'color-ts', js: 'color-js', jsx: 'color-js',
    py: 'color-py', rb: 'color-rb', go: 'color-go', rs: 'color-rs',
    json: 'color-json', md: 'color-md', css: 'color-css', html: 'color-html'
  }
  return map[ext] || ''
}

interface Props {
  rootPath: string
  /** Called with the full path when a file row (never a directory) is clicked. */
  onOpenFile?: (path: string) => void
  /** Path of the file currently open in the editor, highlighted in the tree. */
  selectedPath?: string
}

export default function FileTree({ rootPath, onOpenFile, selectedPath }: Props) {
  const [nodes, setNodes] = useState<FileNode[]>([])

  useEffect(() => {
    const load = async () => {
      const result = await window.electronAPI.readDir(rootPath)
      if (Array.isArray(result)) setNodes(result)
    }
    load()
  }, [rootPath])

  return (
    <div className="file-tree">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} onOpenFile={onOpenFile} selectedPath={selectedPath} />
      ))}
    </div>
  )
}
