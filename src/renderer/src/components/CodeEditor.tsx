import { useState, useEffect, useRef } from 'react'
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

export const CodeEditor = ({ projectPath, openFile, roomId, userName }: CodeEditorProps) => {
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

  // ── Collab-mode: apply Monaco theme + set up Yjs on editor mount ──────────────
  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor

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

  const language2 = openFile ? getLanguage(openFile.name) : language

  return (
    <div className="flex-1 w-full h-full overflow-hidden bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl shadow-2xl relative">
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
            glyphMargin: false,
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
