import { useState, useEffect, useMemo, useRef } from 'react'
import Editor from '@monaco-editor/react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { MonacoBinding } from 'y-monaco'

const YJS_URL = 'ws://localhost:5003'
const DIFF_INTERVAL_MS = 2000

interface CodeEditorProps {
  projectPath: string | null
  openFile?: { path: string; name: string } | null
  roomId?: string | null
  userName?: string
  locks?: CodeLock[]
  mySocketId?: string | null
  isHost?: boolean
  roomUsers?: { id: string; name: string }[]
  lockPanelOpen?: boolean
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

const getLanguage = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql'
  }
  return langMap[ext || ''] || 'plaintext'
}

export const CodeEditor = ({
  projectPath,
  openFile,
  roomId,
  userName,
  locks = [],
  mySocketId = null,
  isHost = false,
  roomUsers = [],
  lockPanelOpen = false
}: CodeEditorProps) => {
  // ── Solo-mode state (no roomId) ───────────────────────────────────────────────
  const [code, setCode] = useState('// Select a file from the sidebar to edit\n')
  const [language, setLanguage] = useState('typescript')
  const editorRef = useRef<any>(null)
  const isRemoteUpdate = useRef(false)
  const codeRef = useRef('// Select a file from the sidebar to edit\n')

  // ── Yjs refs ──────────────────────────────────────────────────────────────────
  const yjsDocRef = useRef<Y.Doc | null>(null)
  const providerRef = useRef<WebsocketProvider | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const diffIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const monacoRef = useRef<any>(null)
  const decorationIdsRef = useRef<string[]>([])
  const localEditWindowUntilRef = useRef(0)
  const guardUndoRef = useRef(false)

  const [lockNotice, setLockNotice] = useState<string>('')
  const [selectedMemberId, setSelectedMemberId] = useState<string>('')
  const [startLineInput, setStartLineInput] = useState<string>('1')
  const [endLineInput, setEndLineInput] = useState<string>('1')

  const activeFilePath = openFile?.path || ''
  const fileLocks = useMemo(
    () => locks.filter((lock) => lock.filePath === activeFilePath),
    [locks, activeFilePath]
  )
  const myLocks = useMemo(
    () => fileLocks.filter((lock) => lock.memberId === mySocketId),
    [fileLocks, mySocketId]
  )
  const foreignLocks = useMemo(
    () => fileLocks.filter((lock) => lock.memberId !== mySocketId),
    [fileLocks, mySocketId]
  )
  const hasAssignedRange = myLocks.length > 0
  const shouldRestrictToAssignedRange = Boolean(roomId && !isHost && hasAssignedRange)

  useEffect(() => {
    if (!selectedMemberId && roomUsers.length > 0) {
      setSelectedMemberId(roomUsers[0].id)
    }
  }, [selectedMemberId, roomUsers])

  useEffect(() => {
    if (!roomId || !window.api.collab) return
    const unsubscribe = window.api.collab.onLockViolation((data) => {
      if (data.filePath === activeFilePath) {
        setLockNotice(data.message)
      }
    })
    return () => unsubscribe()
  }, [roomId, activeFilePath])

  useEffect(() => {
    if (!lockNotice) return
    const timer = setTimeout(() => setLockNotice(''), 2200)
    return () => clearTimeout(timer)
  }, [lockNotice])

  // Cleanup Yjs on unmount or when file/room changes (triggered by key-based remount)
  useEffect(() => {
    return () => {
      if (diffIntervalRef.current) clearInterval(diffIntervalRef.current)
      if (yjsDocRef.current) clearTimeout((yjsDocRef.current as any).__initTimer)
      bindingRef.current?.destroy()
      providerRef.current?.destroy()
      yjsDocRef.current?.destroy()
      diffIntervalRef.current = null
      bindingRef.current = null
      providerRef.current = null
      yjsDocRef.current = null
    }
  }, [roomId, openFile?.path])

  // ── Solo-mode: reset on project change ───────────────────────────────────────
  useEffect(() => {
    if (projectPath && !roomId) {
      setCode('// Select a file from the sidebar to edit\n')
      setLanguage('typescript')
    }
  }, [projectPath, roomId])

  // ── Solo-mode: load file from disk and listen for remote updates ──────────────
  useEffect(() => {
    if (!openFile || roomId) return

    setLanguage(getLanguage(openFile.name))

    window.api.fs.readFile(openFile.path).then((result) => {
      if (result.success && result.content) {
        try {
          const content = atob(result.content)
          isRemoteUpdate.current = true
          setCode(content)
          codeRef.current = content
          isRemoteUpdate.current = false
        } catch {
          setCode('// Unable to decode file content\n')
        }
      } else {
        setCode('// Error reading file\n')
      }
    })
  }, [openFile, roomId])

  useEffect(() => {
    if (!roomId || !window.api.collab) return

    const unsubscribe = window.api.collab.onCodeUpdate((data) => {
      if (data.filePath === openFile?.path) {
        isRemoteUpdate.current = true
        setCode(data.code)
        codeRef.current = data.code
        isRemoteUpdate.current = false
      }
    })

    return () => unsubscribe()
  }, [roomId, openFile?.path])

  // ── Solo-mode: handle local edits ────────────────────────────────────────────
  const handleCodeChange = (value: string | undefined) => {
    if (!value || isRemoteUpdate.current || roomId) return

    const oldCode = codeRef.current
    codeRef.current = value
    setCode(value)

    if (openFile?.path && window.api.collab) {
      window.api.collab.sendCodeChange(roomId ?? '', openFile.path, oldCode, value, userName || 'User')
    }
  }

  const lineInLocks = (line: number, ranges: CodeLock[]): boolean => {
    return ranges.some((lock) => line >= lock.startLine && line <= lock.endLine)
  }

  const intersectsAnyLock = (start: number, end: number, ranges: CodeLock[]): boolean => {
    return ranges.some((lock) => !(end < lock.startLine || start > lock.endLine))
  }

  const isSelectionEditable = (selection: any): boolean => {
    if (!roomId || isHost) return true

    const start = selection.startLineNumber
    const end = selection.endLineNumber

    if (shouldRestrictToAssignedRange) {
      for (let line = start; line <= end; line++) {
        if (!lineInLocks(line, myLocks)) return false
      }
      return true
    }

    return !intersectsAnyLock(start, end, foreignLocks)
  }

  const isChangeEditable = (change: any): boolean => {
    if (!roomId || isHost) return true

    const changedLines = Math.max(1, (change.text || '').split('\n').length)
    const start = change.range.startLineNumber
    const end = Math.max(change.range.endLineNumber, start + changedLines - 1)

    if (shouldRestrictToAssignedRange) {
      for (let line = start; line <= end; line++) {
        if (!lineInLocks(line, myLocks)) return false
      }
      return true
    }

    return !intersectsAnyLock(start, end, foreignLocks)
  }

  const clampCursorToAssignedRanges = (editor: any): void => {
    if (!shouldRestrictToAssignedRange || myLocks.length === 0) return
    const position = editor.getPosition()
    if (!position) return
    if (lineInLocks(position.lineNumber, myLocks)) return

    const sorted = [...myLocks].sort((a, b) => a.startLine - b.startLine)
    const nearest = sorted.reduce((best, current) => {
      const distCurrent = Math.min(
        Math.abs(position.lineNumber - current.startLine),
        Math.abs(position.lineNumber - current.endLine)
      )
      const distBest = Math.min(
        Math.abs(position.lineNumber - best.startLine),
        Math.abs(position.lineNumber - best.endLine)
      )
      return distCurrent < distBest ? current : best
    }, sorted[0])

    const targetLine = position.lineNumber < nearest.startLine ? nearest.startLine : nearest.endLine
    editor.setPosition({ lineNumber: targetLine, column: 1 })
    editor.revealLineInCenter(targetLine)
  }

  const clampSelectionsToAssignedRanges = (editor: any, monaco: any): void => {
    if (!shouldRestrictToAssignedRange || myLocks.length === 0) return
    const selections = editor.getSelections?.() || []
    if (selections.length === 0) return

    const clamped = selections.map((selection: any) => {
      if (isSelectionEditable(selection)) return selection

      const sorted = [...myLocks].sort((a, b) => a.startLine - b.startLine)
      const target = sorted[0]
      return new monaco.Selection(target.startLine, 1, target.startLine, 1)
    })

    editor.setSelections(clamped)
    clampCursorToAssignedRanges(editor)
  }

  const applyLockVisuals = (): void => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const model = editor?.getModel?.()
    if (!editor || !monaco || !model) return

    const lineCount = model.getLineCount()
    const nextDecorations = fileLocks.map((lock) => {
      const start = Math.max(1, Math.min(lineCount, lock.startLine))
      const end = Math.max(start, Math.min(lineCount, lock.endLine))
      const mine = lock.memberId === mySocketId

      return {
        range: new monaco.Range(start, 1, end, 1),
        options: {
          isWholeLine: true,
          className: mine ? 'code-lock-range--mine' : 'code-lock-range--others',
          glyphMarginClassName: mine ? 'code-lock-glyph--mine' : 'code-lock-glyph--others',
          hoverMessage: {
            value: `Locked: ${lock.memberName} (${lock.startLine}-${lock.endLine})`
          }
        }
      }
    })

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, nextDecorations)

    if (!shouldRestrictToAssignedRange || myLocks.length === 0) {
      editor.setHiddenAreas([])
      return
    }

    const sorted = [...myLocks]
      .map((lock) => ({ start: lock.startLine, end: lock.endLine }))
      .sort((a, b) => a.start - b.start)
      .reduce<{ start: number; end: number }[]>((acc, lock) => {
        const last = acc[acc.length - 1]
        if (!last || lock.start > last.end + 1) {
          acc.push({ ...lock })
        } else {
          last.end = Math.max(last.end, lock.end)
        }
        return acc
      }, [])

    const hiddenAreas: any[] = []
    if (sorted[0].start > 1) {
      hiddenAreas.push(new monaco.Range(1, 1, sorted[0].start - 1, 1))
    }

    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i].end + 1
      const to = sorted[i + 1].start - 1
      if (from <= to) {
        hiddenAreas.push(new monaco.Range(from, 1, to, 1))
      }
    }

    if (sorted[sorted.length - 1].end < lineCount) {
      hiddenAreas.push(new monaco.Range(sorted[sorted.length - 1].end + 1, 1, lineCount, 1))
    }

    editor.setHiddenAreas(hiddenAreas)
    clampCursorToAssignedRanges(editor)
  }

  // ── Collab-mode: apply Monaco theme + set up Yjs on editor mount ──────────────
  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor
    monacoRef.current = monaco

    monaco.editor.defineTheme('bitwise-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a0a0a',
        'editor.lineHighlightBackground': '#1a1a1a',
        'editorLineNumber.foreground': '#444444',
        'editorLineNumber.activeForeground': '#ffffff',
        'editor.selectionBackground': '#333333',
        'editorCursor.foreground': '#ffffff',
        'scrollbarSlider.background': '#33333366',
        'scrollbarSlider.hoverBackground': '#44444499',
        'scrollbarSlider.activeBackground': '#555555bb'
      }
    })
    monaco.editor.setTheme('bitwise-dark')
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true
    })
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true
    })

    editor.onDidChangeCursorPosition(() => {
      clampCursorToAssignedRanges(editor)
    })

    editor.onDidChangeCursorSelection(() => {
      clampSelectionsToAssignedRanges(editor, monaco)
    })

    editor.onDidChangeModel(() => {
      applyLockVisuals()
      clampSelectionsToAssignedRanges(editor, monaco)
    })

    editor.onKeyDown((event: any) => {
      const browserEvent = event.browserEvent as KeyboardEvent
      const key = browserEvent.key
      const mayMutate =
        key.length === 1 ||
        key === 'Backspace' ||
        key === 'Delete' ||
        key === 'Enter' ||
        key === 'Tab'

      if (!mayMutate) return
      if (browserEvent.metaKey || browserEvent.ctrlKey || browserEvent.altKey) return

      const selections = editor.getSelections() || []
      const allowed = selections.every((selection: any) => isSelectionEditable(selection))
      if (!allowed) {
        event.preventDefault()
        event.stopPropagation()
        setLockNotice('Edit blocked: outside your assigned lock range')
      } else {
        localEditWindowUntilRef.current = Date.now() + 1000
      }
    })

    editor.onDidPaste(() => {
      localEditWindowUntilRef.current = Date.now() + 1000
    })

    editor.onDidChangeModelContent((e: any) => {
      applyLockVisuals()

      if (guardUndoRef.current) return
      if (!roomId || isHost) return
      if (Date.now() > localEditWindowUntilRef.current) return

      const hasForbiddenChange = e.changes.some((change: any) => !isChangeEditable(change))
      if (!hasForbiddenChange) return

      guardUndoRef.current = true
      editor.trigger('code-lock', 'undo', null)
      guardUndoRef.current = false
      setLockNotice('Edit blocked: this range is locked')
      clampSelectionsToAssignedRanges(editor, monaco)
    })

    applyLockVisuals()

    if (!roomId || !openFile) return

    // ── Yjs setup ──────────────────────────────────────────────────────────────
    const ydoc = new Y.Doc()
    yjsDocRef.current = ydoc

    // Each room+file gets its own Yjs document
    const docName = `${roomId}::${openFile.path}`
    const provider = new WebsocketProvider(YJS_URL, docName, ydoc, {
      connect: true,
      resyncInterval: 3000
    })
    providerRef.current = provider

    const yText = ydoc.getText('content')

    // After 2s, if the doc is still empty, this client is the host — seed from disk
    const initTimer = setTimeout(async () => {
      if (yText.length === 0) {
        const result = await window.api.fs.readFile(openFile.path)
        if (result.success && result.content) {
          try {
            const content = atob(result.content)
            ydoc.transact(() => {
              if (yText.length === 0) yText.insert(0, content)
            })
          } catch { /* ignore decode errors */ }
        }
      }
    }, 2000)

    // Bind Yjs text to Monaco model — CRDT handles all conflict resolution
    const model = editor.getModel()
    if (model) {
      bindingRef.current = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        provider.awareness
      )
    }

    // Emit periodic snapshots to Socket.io for the DiffViewer
    let prevContent = ''
    diffIntervalRef.current = setInterval(() => {
      if (!window.api.collab) return
      const current = yText.toString()
      if (current !== prevContent) {
        window.api.collab.sendCodeChange(roomId, openFile.path, prevContent, current, userName || 'User')
        prevContent = current
      }
    }, DIFF_INTERVAL_MS)

    // Store initTimer so cleanup can cancel it if user switches files quickly
    ;(yjsDocRef.current as any).__initTimer = initTimer
  }

  useEffect(() => {
    applyLockVisuals()
  }, [fileLocks, myLocks, shouldRestrictToAssignedRange, mySocketId])

  const activeMember = roomUsers.find((member) => member.id === selectedMemberId)

  const assignLockForCurrentFile = async () => {
    if (!roomId || !openFile || !window.api.collab) return
    if (!selectedMemberId || !activeMember) {
      setLockNotice('Pick a member before assigning a lock')
      return
    }

    const start = Number(startLineInput)
    const end = Number(endLineInput)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      setLockNotice('Invalid lock range')
      return
    }

    try {
      const result = await window.api.collab.assignLock(
        roomId,
        openFile.path,
        selectedMemberId,
        activeMember.name,
        start,
        end
      )

      if (!result) {
        setLockNotice('Unable to assign lock')
        return
      }

      setLockNotice(`Lock assigned to ${activeMember.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to assign lock'
      setLockNotice(message)
    }
  }

  const removeLockFromCurrentFile = async (lockId: string) => {
    if (!roomId || !window.api.collab) return
    try {
      const ok = await window.api.collab.removeLock(roomId, lockId)
      setLockNotice(ok ? 'Lock removed' : 'Unable to remove lock')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to remove lock'
      setLockNotice(message)
    }
  }

  const language2 = openFile ? getLanguage(openFile.name) : language

  return (
    <div className="flex-1 w-full h-full overflow-hidden bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl shadow-2xl relative">
      {lockNotice && (
        <div className="absolute z-20 top-3 left-3 right-3 px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-200 text-xs">
          {lockNotice}
        </div>
      )}

      {roomId && openFile && lockPanelOpen && (
        <div className="absolute z-20 top-3 right-3 w-[360px] rounded-lg border border-[#2a2a2a] bg-[#0a0a0a]/95 p-3 backdrop-blur-sm">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Code Locks</p>

              <div className="mt-2">
                <label className="text-[10px] uppercase tracking-wider text-gray-500">Member</label>
                <select
                  value={selectedMemberId}
                  onChange={(e) => setSelectedMemberId(e.target.value)}
                  className="mt-1 w-full bg-[#111] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white"
                >
                  <option value="">Select member</option>
                  {roomUsers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500">Start line</label>
                  <input
                    type="number"
                    min={1}
                    value={startLineInput}
                    onChange={(e) => setStartLineInput(e.target.value)}
                    placeholder="e.g. 10"
                    className="mt-1 w-full bg-[#111] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500">End line</label>
                  <input
                    type="number"
                    min={1}
                    value={endLineInput}
                    onChange={(e) => setEndLineInput(e.target.value)}
                    placeholder="e.g. 25"
                    className="mt-1 w-full bg-[#111] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white"
                  />
                </div>

                <button
                  onClick={assignLockForCurrentFile}
                  className="col-span-2 rounded bg-[#1a1a1a] border border-[#2a2a2a] hover:bg-[#252525] text-white text-xs font-medium py-1.5"
                >
                  Assign / Reassign Lock
                </button>
              </div>

              {!isHost && (
                <p className="mt-2 text-[11px] text-gray-500">
                  If assignment fails, this client is not recognized as host yet.
                </p>
              )}

              <div className="mt-3 space-y-1.5 max-h-32 overflow-y-auto">
                {fileLocks.length === 0 ? (
                  <p className="text-[11px] text-gray-500">No locks on this file.</p>
                ) : (
                  fileLocks.map((lock) => (
                    <div
                      key={lock.id}
                      className="flex items-center justify-between rounded border border-[#2a2a2a] bg-[#111] px-2 py-1"
                    >
                      <span className="text-[11px] text-gray-300">
                        {lock.memberName}: {lock.startLine}-{lock.endLine}
                      </span>
                      <button
                        onClick={() => removeLockFromCurrentFile(lock.id)}
                        className="text-[11px] text-gray-300 hover:text-white"
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
      )}

      <div className="h-full w-full">
        <Editor
          key={`${roomId ?? 'solo'}:${openFile?.path ?? 'none'}`}
          height="100%"
          defaultLanguage={language2}
          language={language2}
          theme="vs-dark"
          // In collab mode Yjs owns the content; only bind value/onChange in solo mode
          value={roomId ? undefined : code}
          onChange={roomId ? undefined : handleCodeChange}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            padding: { top: 20 },
            lineNumbers: 'on',
            glyphMargin: true,
            folding: true,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            scrollbar: {
              vertical: 'visible',
              horizontal: 'visible',
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10
            }
          }}
          loading={
            <div className="h-full w-full flex items-center justify-center text-gray-500 font-medium animate-pulse">
              Loading...
            </div>
          }
        />
      </div>
    </div>
  )
}
