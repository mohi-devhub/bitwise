/// <reference types="vite/client" />

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: string
  children?: FileEntry[]
}

interface FileChange {
  id: string
  filePath: string
  userId: string
  userName: string
  timestamp: number
  oldContent: string
  newContent: string
  lineChanges: { line: number; type: 'add' | 'remove' | 'modify'; content: string }[]
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

interface Window {
  api: {
    dialog: {
      openFolder: () => Promise<string | null>
    }
    fs: {
      readDirectory: (dirPath: string) => Promise<FileEntry[]>
      readFile: (
        filePath: string
      ) => Promise<{ success: boolean; content?: string; encoding?: string; error?: string }>
    }
    terminal: {
      create: (id: string, cwd?: string) => void
      write: (id: string, data: string) => void
      resize: (id: string, cols: number, rows: number) => void
      destroy: (id: string) => void
      onData: (id: string, callback: (data: string) => void) => () => void
    }
    shell: {
      openExternal: (url: string) => void
    }
    collab: {
      connect: (roomId: string, userName: string) => Promise<void>
      disconnect: () => void
      sendCodeChange: (
        roomId: string,
        filePath: string,
        oldCode: string,
        newCode: string,
        userName: string
      ) => void
      onCodeUpdate: (callback: (data: { filePath: string; code: string }) => void) => () => void
      getAllChanges: (roomId: string) => Promise<{ changes: FileChange[] }>
      onUserJoined: (callback: (data: { userId: string; userName: string }) => void) => () => void
      onUserLeft: (callback: (user: { id: string; name: string }) => void) => () => void
      onChangeMade: (callback: (change: FileChange) => void) => () => void
      shareProject: (roomId: string, projectPath: string, fileTree: any[]) => void
      onProjectShared: (
        callback: (data: { projectPath: string; fileTree: any[] }) => void
      ) => () => void
      requestProject: (roomId: string) => void
      sendChatMessage: (roomId: string, content: string) => void
      onChatMessage: (callback: (message: any) => void) => () => void
      onChatMessageSent: (callback: (message: any) => void) => () => void
      getChatHistory: (roomId: string) => Promise<any[]>
      assignFile: (
        roomId: string,
        filePath: string,
        assigneeId: string,
        assigneeName: string,
        message?: string
      ) => void
      onFileAssigned: (
        callback: (data: { filePath: string; assigneeId: string; assigneeName: string }) => void
      ) => () => void
      isConnected: () => boolean
      getMySocketId: () => string | null
      getIsHost: () => boolean
      getInitialLocks: () => CodeLock[]
      assignLock: (
        roomId: string,
        filePath: string,
        memberId: string,
        memberName: string,
        startLine: number,
        endLine: number
      ) => Promise<{ lock: CodeLock } | null>
      removeLock: (roomId: string, lockId: string) => Promise<boolean>
      getLocks: (roomId: string) => Promise<CodeLock[]>
      onLockAssigned: (callback: (lock: CodeLock) => void) => () => void
      onLockRemoved: (callback: (data: { lockId: string }) => void) => () => void
      onLockViolation: (callback: (data: { filePath: string; message: string }) => void) => () => void
    }
  }
  electron: {
    process: {
      versions: NodeJS.ProcessVersions
    }
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void
      on: (channel: string, func: (...args: unknown[]) => void) => void
    }
  }
}
