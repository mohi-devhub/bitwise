import { useState, useEffect } from 'react'
import { ChevronDown, X, ChevronRight, FileDiff, Lock } from 'lucide-react'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: string
  children?: FileEntry[]
}

export interface SidebarProps {
  onClose: () => void
  isOpen: boolean
  projectPath: string | null
  sharedFileTree?: FileEntry[] | null
  isCollaborative?: boolean
  onFileClick?: (path: string, name: string) => void
  onDiffViewerClick?: () => void
  onCodeLocksClick?: () => void
}

export const Sidebar = ({
  onClose,
  isOpen,
  projectPath,
  sharedFileTree,
  isCollaborative = false,
  onFileClick,
  onDiffViewerClick,
  onCodeLocksClick
}: SidebarProps) => {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (projectPath) {
      setLoading(true)
      window.api.fs.readDirectory(projectPath).then((entries) => {
        setFiles(entries)
        setLoading(false)
      })
    } else if (sharedFileTree && sharedFileTree.length > 0) {
      setFiles(sharedFileTree)
    }
  }, [projectPath, sharedFileTree])

  const toggleFolder = async (path: string) => {
    const newExpanded = new Set(expandedFolders)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedFolders(newExpanded)
  }

  const renderFileTree = (entries: FileEntry[], depth: number = 0) => {
    return entries.map((entry, idx) => (
      <div key={`${entry.path}-${idx}`}>
        <div
          className="flex items-center space-x-2 py-1.5 px-2 hover:bg-white/5 rounded-md cursor-pointer group transition-all"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            if (entry.isDirectory) {
              toggleFolder(entry.path)
            } else {
              onFileClick?.(entry.path, entry.name)
            }
          }}
        >
          {entry.isDirectory ? (
            <>
              {expandedFolders.has(entry.path) ? (
                <ChevronDown size={14} className="text-gray-500" />
              ) : (
                <ChevronRight size={14} className="text-gray-500" />
              )}
            </>
          ) : (
            <div className="w-3.5" />
          )}
          <span className="text-xs font-medium text-gray-300 group-hover:text-white transition-colors">
            {entry.name}
          </span>
        </div>
        {entry.isDirectory && expandedFolders.has(entry.path) && entry.children && (
          <div className="mt-1">{renderFileTree(entry.children, depth + 1)}</div>
        )}
      </div>
    ))
  }

  useEffect(() => {
    const loadFolderContents = async (path: string) => {
      const entries = await window.api.fs.readDirectory(path)
      setFiles((prev) => {
        const updateChildren = (items: FileEntry[]): FileEntry[] => {
          return items.map((item) => {
            if (item.path === path) {
              return { ...item, children: entries }
            }
            if (item.children) {
              return { ...item, children: updateChildren(item.children) }
            }
            return item
          })
        }
        return updateChildren(prev)
      })
    }

    expandedFolders.forEach((path) => {
      const findEntry = (entries: FileEntry[]): FileEntry | undefined => {
        for (const entry of entries) {
          if (entry.path === path) return entry
          if (entry.children) {
            const found = findEntry(entry.children)
            if (found) return found
          }
        }
        return undefined
      }

      const entry = findEntry(files)
      if (entry && !entry.children) {
        loadFolderContents(path)
      }
    })
  }, [expandedFolders])

  if (!isOpen) return null

  return (
    <div className="w-64 h-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl p-4 flex flex-col shadow-2xl transition-all duration-300">
      <div className="flex items-center justify-between">
        <div className="w-full flex justify-end space-x-1">
          <button
            onClick={onClose}
            className="p-1 hover:bg-red-500/10 hover:text-red-500 rounded transition-colors text-gray-500"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="text-xs text-gray-500 p-2">Loading...</div>
        ) : files.length > 0 ? (
          renderFileTree(files)
        ) : isCollaborative ? (
          <div className="text-xs text-gray-500 p-4 text-center">
            <p className="mb-2">Collaborative session active</p>
            <p className="text-gray-600">Host hasn't shared a project yet</p>
          </div>
        ) : (
          <div className="text-xs text-gray-500 p-2">No folder opened</div>
        )}
      </div>

      <div className="mt-2 pt-2 border-t border-[#2a2a2a] grid grid-cols-2 gap-2">
        <button
          onClick={onDiffViewerClick}
          className="flex items-center justify-center space-x-2 w-full px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
        >
          <FileDiff size={14} />
          <span>Diff Viewer</span>
        </button>

        <button
          onClick={onCodeLocksClick}
          className="flex items-center justify-center space-x-2 w-full px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
        >
          <Lock size={14} />
          <span>Code Locks</span>
        </button>
      </div>
    </div>
  )
}
