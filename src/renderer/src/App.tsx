import { useState, useEffect } from 'react'
import WelcomePage from './Pages/WelcomePage'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { CodeEditor } from './components/CodeEditor'
import { CanvasView } from './components/CanvasView'
import { Terminal } from './components/Terminal'
import { CollaborativeModal } from './components/CollaborativeModal'
import { ChatView } from './components/ChatView'
import { DiffViewer } from './components/DiffViewer'
import { X } from 'lucide-react'

interface OpenFile {
  path: string
  name: string
}

interface CodeLock {
  id: string
  filePath: string
  memberId: string
  memberName: string
  startLine: number
  endLine: number
  assignedAt: number
}

interface RecentProject {
  path: string
  name: string
  lastOpened: number
}

const MAX_RECENT_PROJECTS = 5

const getProjectName = (path: string): string => {
  const parts = path.split('/')
  return parts[parts.length - 1] || parts[parts.length - 2] || path
}

export default function App() {
  const [showIDE, setShowIDE] = useState(false)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState<number>(-1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [diffViewerOpen, setDiffViewerOpen] = useState(false)
  const [lockPanelOpen, setLockPanelOpen] = useState(false)
  const [collaborativeModalOpen, setCollaborativeModalOpen] = useState(false)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>('User')
  const [sharedFileTree, setSharedFileTree] = useState<any[]>([])
  const [localFileTree, setLocalFileTree] = useState<any[]>([])
  const [roomUsers, setRoomUsers] = useState<{ id: string; name: string }[]>([])
  const [activeView, setActiveView] = useState<'code' | 'canvas'>('code')
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [locks, setLocks] = useState<CodeLock[]>([])
  const [mySocketId, setMySocketId] = useState<string | null>(null)
  const [isHost, setIsHost] = useState(false)
  const [lockAccessNotice, setLockAccessNotice] = useState<string>('')

  useEffect(() => {
    const saved = localStorage.getItem('recentProjects')
    if (saved) {
      try {
        setRecentProjects(JSON.parse(saved))
      } catch {
        setRecentProjects([])
      }
    }
  }, [])

  useEffect(() => {
    if (!roomId || !window.api.collab) return

    const unsubscribe = window.api.collab.onProjectShared((data) => {
      setSharedFileTree(data.fileTree || [])
    })

    window.api.collab.requestProject(roomId)

    return () => unsubscribe()
  }, [roomId])

  useEffect(() => {
    if (!roomId || !window.api.collab) return

    const unsubscribeJoined = window.api.collab.onUserJoined((data) => {
      setRoomUsers((prev) => [...prev, { id: data.userId, name: data.userName }])
    })

    const unsubscribeLeft = window.api.collab.onUserLeft((user) => {
      setRoomUsers((prev) => prev.filter((u) => u.id !== user.id))
    })

    return () => {
      unsubscribeJoined()
      unsubscribeLeft()
    }
  }, [roomId])

  // ── Lock state ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId || !window.api.collab) return

    // These are synchronously set by the 'room-joined' event during connect()
    setMySocketId(window.api.collab.getMySocketId())
    setIsHost(window.api.collab.getIsHost())
    setLocks(window.api.collab.getInitialLocks())
    window.api.collab.getLocks(roomId).then((currentLocks) => setLocks(currentLocks))

    const unsubAssigned = window.api.collab.onLockAssigned((lock: CodeLock) => {
      setLocks((prev) => {
        if (prev.some((existing) => existing.id === lock.id)) return prev
        return [...prev, lock]
      })
    })

    const unsubRemoved = window.api.collab.onLockRemoved(({ lockId }: { lockId: string }) => {
      setLocks((prev) => prev.filter((l) => l.id !== lockId))
    })

    return () => {
      unsubAssigned()
      unsubRemoved()
    }
  }, [roomId])

  useEffect(() => {
    if (!projectPath) {
      setLocalFileTree([])
      return
    }

    window.api.fs.readDirectory(projectPath).then((entries) => {
      setLocalFileTree(entries || [])
    })
  }, [projectPath])

  useEffect(() => {
    if (!projectPath || !roomId || !window.api.collab) return

    const shareAllFiles = async (entries: any[]) => {
      for (const entry of entries) {
        if (entry.isDirectory && entry.children) {
          await shareAllFiles(entry.children)
        } else {
          try {
            const result = await window.api.fs.readFile(entry.path)
            if (result.success && result.content) {
              const content = atob(result.content)
                ;(window.api.collab as any).sendFileContent?.(roomId, entry.path, content)
            }
          } catch (e) {
            console.error('Error reading file:', entry.path, e)
          }
        }
      }
    }

    window.api.fs.readDirectory(projectPath).then((entries) => {
      window.api.collab.shareProject(roomId, projectPath, entries)
      shareAllFiles(entries)
    })
  }, [projectPath, roomId])

  const addRecentProject = (path: string) => {
    const name = getProjectName(path)
    const updated = [
      { path, name, lastOpened: Date.now() },
      ...recentProjects.filter((p) => p.path !== path)
    ].slice(0, MAX_RECENT_PROJECTS)
    setRecentProjects(updated)
    localStorage.setItem('recentProjects', JSON.stringify(updated))
  }

  const activeFile = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null
  const myAssignedLocks = locks.filter((lock) => lock.memberId === mySocketId)
  const assignedFilePaths = new Set(myAssignedLocks.map((lock) => lock.filePath))

  useEffect(() => {
    if (!roomId || isHost) return
    if (myAssignedLocks.length === 0) return

    setOpenFiles((prev) => {
      const filtered = prev.filter((file) => assignedFilePaths.has(file.path))

      setActiveFileIndex((prevIndex) => {
        if (filtered.length === 0) return -1
        if (prevIndex < 0) return 0

        const prevFile = prev[prevIndex]
        if (!prevFile) return 0

        const nextIndex = filtered.findIndex((file) => file.path === prevFile.path)
        return nextIndex === -1 ? 0 : nextIndex
      })

      return filtered
    })
  }, [roomId, isHost, myAssignedLocks.length, mySocketId, locks])

  const handleFileClick = (path: string, name: string) => {
    if (roomId && !isHost && myAssignedLocks.length > 0 && !assignedFilePaths.has(path)) {
      setLockAccessNotice('You can only open files assigned to you by the host')
      return
    }

    const existingIndex = openFiles.findIndex((f) => f.path === path)
    if (existingIndex >= 0) {
      setActiveFileIndex(existingIndex)
    } else {
      setOpenFiles([...openFiles, { path, name }])
      setActiveFileIndex(openFiles.length)
    }
  }

  const handleCloseFile = (index: number) => {
    const newFiles = openFiles.filter((_, i) => i !== index)
    setOpenFiles(newFiles)
    if (activeFileIndex >= newFiles.length) {
      setActiveFileIndex(newFiles.length - 1)
    } else if (index < activeFileIndex) {
      setActiveFileIndex(activeFileIndex - 1)
    }
  }

  useEffect(() => {
    setLockPanelOpen(false)
  }, [activeFile?.path, roomId])

  useEffect(() => {
    if (!lockAccessNotice) return
    const timer = setTimeout(() => setLockAccessNotice(''), 2200)
    return () => clearTimeout(timer)
  }, [lockAccessNotice])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        setTerminalOpen((prev) => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen((prev) => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        setChatOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleEnterIde = (path?: string) => {
    if (path) {
      setProjectPath(path)
      addRecentProject(path)
    }
    setShowIDE(true)
  }

  const handleJoinSession = async (roomId: string, userName: string) => {
    if (window.api.collab) {
      await window.api.collab.connect(roomId, userName)
      setRoomId(roomId)
      setUserName(userName)
      setShowIDE(true)
      setSidebarOpen(true)
    }
  }

  if (!showIDE) {
    return (
      <WelcomePage
        onEnterIde={handleEnterIde}
        recentProjects={recentProjects}
        onJoinSession={handleJoinSession}
      />
    )
  }

  return (
    <div className="w-full h-screen bg-black gap-4 p-4 flex flex-col overflow-hidden">
      <Toolbar
        onCollaborativeClick={() => setCollaborativeModalOpen(true)}
        onChatClick={() => setChatOpen((prev) => !prev)}
        activeView={activeView}
        onViewChange={setActiveView}
      />

      <div className="flex-1 flex mt-4 gap-4 overflow-hidden">
        <Sidebar
          onClose={() => setSidebarOpen(false)}
          isOpen={sidebarOpen}
          projectPath={projectPath}
          sharedFileTree={sharedFileTree}
          isCollaborative={!!roomId}
          onFileClick={handleFileClick}
          onDiffViewerClick={() => setDiffViewerOpen(true)}
          onCodeLocksClick={() => setLockPanelOpen((prev) => !prev)}
        />

        <div className="flex-1 flex flex-col gap-4 overflow-hidden relative">
          {lockAccessNotice && (
            <div className="absolute z-20 top-2 left-2 right-2 px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-200 text-xs">
              {lockAccessNotice}
            </div>
          )}

          {/* ✅ EDITOR VIEW - Hidden via CSS when not active */}
          <div
            className={`flex-1 flex-col overflow-hidden ${activeView === 'code' ? 'flex' : 'hidden'}`}
          >
            {openFiles.length > 0 && (
              <div className="flex items-center bg-[#0d0d0d] border border-[#2a2a2a] rounded-t-xl border-b-0">
                {openFiles.map((file, index) => (
                  <button
                    key={file.path}
                    onClick={() => setActiveFileIndex(index)}
                    className={`flex items-center space-x-2 px-4 py-2 text-xs border-r border-[#2a2a2a] transition-colors ${
                      index === activeFileIndex
                        ? 'bg-[#1a1a1a] text-white'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-[#151515]'
                    }`}
                  >
                    <span>{file.name}</span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCloseFile(index)
                      }}
                      className="pl-3 hover:text-red-500"
                    >
                      <X size={12} />
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              {activeFile ? (
                <CodeEditor
                  projectPath={projectPath}
                  openFile={activeFile}
                  roomId={roomId}
                  userName={userName}
                  locks={locks}
                  mySocketId={mySocketId}
                  isHost={isHost}
                  roomUsers={roomUsers}
                  lockPanelOpen={lockPanelOpen}
                />
              ) : (
                <div className="flex-1 w-full h-full overflow-hidden bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl flex items-center justify-center">
                  <p className="text-gray-500">Select a file from the sidebar to edit</p>
                </div>
              )}
            </div>
          </div>

          {/* ✅ CANVAS VIEW - Hidden via CSS when not active */}
          <div
            className={`flex-1 w-full h-full overflow-hidden ${activeView === 'canvas' ? 'block' : 'hidden'}`}
          >
            <CanvasView />
          </div>

          <Terminal
            onClose={() => setTerminalOpen(false)}
            isOpen={terminalOpen}
            projectPath={projectPath}
          />
        </div>

        <ChatView
          onClose={() => setChatOpen(false)}
          isOpen={chatOpen}
          onSetupCollab={() => setCollaborativeModalOpen(true)}
          isCollabSetup={!!roomId}
          roomId={roomId}
          userName={userName}
          fileTree={localFileTree.length > 0 ? localFileTree : sharedFileTree}
          roomUsers={roomUsers}
        />

        <DiffViewer
          onClose={() => setDiffViewerOpen(false)}
          isOpen={diffViewerOpen}
          roomId={roomId}
        />
      </div>

      <CollaborativeModal
        onClose={() => setCollaborativeModalOpen(false)}
        isOpen={collaborativeModalOpen}
        onRoomJoined={(id, name) => {
          setRoomId(id)
          setUserName(name)
        }}
      />
    </div>
  )
}
