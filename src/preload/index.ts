import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: string
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

let socket: any = null
let io: any = null
const SOCKET_URL = 'http://localhost:5002'

// Module-level lock identity — populated by the 'room-joined' event during connect()
let _mySocketId: string | null = null
let _isHost = false
let _initialLocks: CodeLock[] = []

const loadSocketIO = async () => {
  if (io) return io
  const socketIO = await import('socket.io-client')
  io = socketIO.io
  return io
}

const api = {
  terminal: {
    create: (id: string, cwd?: string) => ipcRenderer.send('terminal:create', id, cwd),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    destroy: (id: string) => ipcRenderer.send('terminal:destroy', id),
    onData: (id: string, callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`terminal:data:${id}`, listener)
      return () => ipcRenderer.removeListener(`terminal:data:${id}`, listener)
    }
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  },
  fs: {
    readDirectory: (dirPath: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fs:readDirectory', dirPath),
    readFile: (
      filePath: string
    ): Promise<{ success: boolean; content?: string; encoding?: string; error?: string }> =>
      ipcRenderer.invoke('fs:readFile', filePath)
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },
  collab: {
    connect: async (roomId: string, userName: string): Promise<void> => {
      try {
        const SocketIO = await loadSocketIO()

        if (socket) {
          socket.disconnect()
        }

        // Reset identity for the new connection
        _mySocketId = null
        _isHost = false
        _initialLocks = []

        socket = SocketIO(SOCKET_URL, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000
        })

        return new Promise<void>((resolve) => {
          let didResolve = false
          let hasRoomJoined = false
          let hasRoomUsers = false

          const maybeResolve = () => {
            if (didResolve) return
            if (!hasRoomJoined || !hasRoomUsers) return
            didResolve = true
            clearTimeout(timeout)
            resolve()
          }

          const timeout = setTimeout(() => {
            if (didResolve) return
            didResolve = true
            console.warn('Socket connection timeout, but continuing...')
            resolve()
          }, 5000)

          socket.on('connect', () => {
            console.log('Socket connected:', socket.id)
            // Use the current socket id immediately; room-joined can still refine this.
            _mySocketId = socket.id
            socket.emit('join-room', { roomId, userName })
          })

          // Capture host/identity info (fires before room-users in server handler)
          socket.on(
            'room-joined',
            (data: { socketId: string; isHost: boolean; locks: CodeLock[] }) => {
              _mySocketId = data.socketId
              _isHost = data.isHost
              _initialLocks = data.locks || []
              hasRoomJoined = true
              maybeResolve()
            }
          )

          socket.on('room-users', (users: any[]) => {
            console.log('Room users:', users)
            hasRoomUsers = true
            maybeResolve()
          })

          socket.on('connect_error', (err: Error) => {
            console.error('Socket connection error:', err.message)
            if (didResolve) return
            didResolve = true
            clearTimeout(timeout)
            resolve()
          })

          socket.on('error', (err: Error) => {
            console.error('Socket error:', err.message)
          })
        })
      } catch (error) {
        console.error('Failed to connect:', error)
      }
    },

    disconnect: () => {
      if (socket) {
        socket.disconnect()
        socket = null
      }
      _mySocketId = null
      _isHost = false
      _initialLocks = []
    },

    sendCodeChange: (
      roomId: string,
      filePath: string,
      oldCode: string,
      newCode: string,
      userName: string
    ) => {
      if (socket && socket.connected) {
        socket.emit('code-change', { roomId, filePath, oldCode, newCode, userName })
      }
    },

    onCodeUpdate: (callback: (data: { filePath: string; code: string }) => void) => {
      if (socket) {
        socket.on('code-update', callback)
        return () => socket.off('code-update', callback)
      }
      return () => {}
    },

    getAllChanges: async (roomId: string): Promise<{ changes: FileChange[] }> => {
      return new Promise((resolve) => {
        if (!socket || !socket.connected) {
          resolve({ changes: [] })
          return
        }

        socket.emit('get-all-changes', { roomId })

        const timeout = setTimeout(() => {
          resolve({ changes: [] })
        }, 1000)

        socket.once('all-changes', (data: { changes: FileChange[] }) => {
          clearTimeout(timeout)
          resolve(data)
        })
      })
    },

    onUserJoined: (callback: (data: { userId: string; userName: string }) => void) => {
      if (socket) {
        socket.on('user-joined', callback)
        return () => socket.off('user-joined', callback)
      }
      return () => {}
    },

    onUserLeft: (callback: (user: { id: string; name: string }) => void) => {
      if (socket) {
        socket.on('user-left', callback)
        return () => socket.off('user-left', callback)
      }
      return () => {}
    },

    onChangeMade: (callback: (change: FileChange) => void) => {
      if (socket) {
        socket.on('change-made', callback)
        return () => socket.off('change-made', callback)
      }
      return () => {}
    },

    shareProject: (roomId: string, projectPath: string, fileTree: any[]) => {
      if (socket && socket.connected) {
        socket.emit('share-project', { roomId, projectPath, fileTree })
      }
    },

    onProjectShared: (callback: (data: { projectPath: string; fileTree: any[] }) => void) => {
      if (socket) {
        socket.on('project-shared', callback)
        return () => socket.off('project-shared', callback)
      }
      return () => {}
    },

    requestProject: (roomId: string) => {
      if (socket && socket.connected) {
        socket.emit('get-project', { roomId })
      }
    },

    sendChatMessage: (roomId: string, content: string) => {
      if (socket && socket.connected) {
        socket.emit('chat-message', { roomId, content })
      }
    },

    onChatMessage: (callback: (message: any) => void) => {
      if (socket) {
        socket.on('chat-message', callback)
        return () => socket.off('chat-message', callback)
      }
      return () => {}
    },

    onChatMessageSent: (callback: (message: any) => void) => {
      if (socket) {
        socket.on('chat-message-sent', callback)
        return () => socket.off('chat-message-sent', callback)
      }
      return () => {}
    },

    getChatHistory: (roomId: string): Promise<any[]> => {
      return new Promise((resolve) => {
        if (!socket || !socket.connected) {
          resolve([])
          return
        }
        socket.emit('get-chat-history', { roomId })
        const timeout = setTimeout(() => resolve([]), 1000)
        socket.once('chat-history', (data: { messages: any[] }) => {
          clearTimeout(timeout)
          resolve(data.messages || [])
        })
      })
    },

    assignFile: (
      roomId: string,
      filePath: string,
      assigneeId: string,
      assigneeName: string,
      message?: string
    ) => {
      if (socket && socket.connected) {
        socket.emit('assign-file', { roomId, filePath, assigneeId, assigneeName, message })
      }
    },

    onFileAssigned: (
      callback: (data: { filePath: string; assigneeId: string; assigneeName: string }) => void
    ) => {
      if (socket) {
        socket.on('file-assigned', callback)
        return () => socket.off('file-assigned', callback)
      }
      return () => {}
    },

    isConnected: (): boolean => {
      return socket && socket.connected
    },

    // ── CODE LOCK API ─────────────────────────────────────────────────────────

    /** Returns the socket ID assigned to this client after joining a room. */
    getMySocketId: (): string | null => _mySocketId,

    /** Returns true if this client is the host of the current room. */
    getIsHost: (): boolean => _isHost,

    /** Returns the locks that were active when this client joined (from room-joined). */
    getInitialLocks: (): CodeLock[] => _initialLocks,

    /** Host assigns a line-range lock to a member (socket-based with ack). */
    assignLock: (
      roomId: string,
      filePath: string,
      memberId: string,
      memberName: string,
      startLine: number,
      endLine: number
    ): Promise<{ lock: CodeLock } | null> => {
      if (!socket || !socket.connected) {
        return Promise.reject(new Error('Collaboration socket is disconnected'))
      }

      const socketId = _mySocketId || socket.id
      if (!socketId) {
        return Promise.reject(new Error('Socket identity is unavailable, please reconnect the room'))
      }

      return new Promise((resolve, reject) => {
        let settled = false
        const complete = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }

        const onLockAssigned = (lock: CodeLock) => {
          if (lock.filePath !== filePath) return
          if (lock.memberId !== memberId) return
          if (Number(lock.startLine) !== Number(startLine) || Number(lock.endLine) !== Number(endLine)) {
            return
          }
          complete(() => {
            clearTimeout(timeout)
            socket.off('lock-assigned', onLockAssigned)
            resolve({ lock })
          })
        }

        socket.on('lock-assigned', onLockAssigned)

        const timeout = setTimeout(() => {
          const tryResolveFromLocksState = () => {
            let checked = false
            const finishCheck = (locks: CodeLock[]) => {
              if (checked) return
              checked = true

              const matched = locks.find((lock) => {
                return (
                  lock.filePath === filePath &&
                  lock.memberId === memberId &&
                  Number(lock.startLine) === Number(startLine) &&
                  Number(lock.endLine) === Number(endLine)
                )
              })

              complete(() => {
                socket.off('lock-assigned', onLockAssigned)
                if (matched) {
                  resolve({ lock: matched })
                } else {
                  reject(new Error('Lock assignment timed out'))
                }
              })
            }

            socket.once('locks-state', (data: { locks: CodeLock[] }) => {
              finishCheck(data?.locks || [])
            })

            socket.emit(
              'get-locks',
              { roomId },
              (response: { ok: boolean; locks?: CodeLock[] }) => {
                if (response?.ok && Array.isArray(response?.locks)) {
                  finishCheck(response.locks)
                }
              }
            )

            setTimeout(() => finishCheck([]), 1200)
          }

          tryResolveFromLocksState()
        }, 5000)

        socket.emit(
          'assign-lock',
          {
            roomId,
            filePath,
            memberId,
            memberName,
            startLine,
            endLine,
            socketId
          },
          (response: { ok: boolean; lock?: CodeLock; error?: string }) => {
            complete(() => {
              clearTimeout(timeout)
              socket.off('lock-assigned', onLockAssigned)
              if (!response?.ok) {
                reject(new Error(response?.error || 'Failed to assign lock'))
                return
              }
              if (!response.lock) {
                reject(new Error('Lock assignment response missing lock data'))
                return
              }
              resolve({ lock: response.lock })
            })
          }
        )
      })
    },

    /** Host removes a lock by ID (socket-based with ack). */
    removeLock: (roomId: string, lockId: string): Promise<boolean> => {
      if (!socket || !socket.connected) {
        return Promise.reject(new Error('Collaboration socket is disconnected'))
      }

      const socketId = _mySocketId || socket.id
      if (!socketId) {
        return Promise.reject(new Error('Socket identity is unavailable, please reconnect the room'))
      }

      return new Promise((resolve, reject) => {
        let settled = false
        const complete = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }

        const onLockRemoved = (data: { lockId: string }) => {
          if (!data || data.lockId !== lockId) return
          complete(() => {
            clearTimeout(timeout)
            socket.off('lock-removed', onLockRemoved)
            resolve(true)
          })
        }

        socket.on('lock-removed', onLockRemoved)

        const timeout = setTimeout(() => {
          complete(() => {
            socket.off('lock-removed', onLockRemoved)
            reject(new Error('Remove lock timed out'))
          })
        }, 5000)

        socket.emit(
          'remove-lock',
          {
            roomId,
            lockId,
            socketId
          },
          (response: { ok: boolean; error?: string }) => {
            complete(() => {
              clearTimeout(timeout)
              socket.off('lock-removed', onLockRemoved)
              if (!response?.ok) {
                reject(new Error(response?.error || 'Failed to remove lock'))
                return
              }
              resolve(true)
            })
          }
        )
      })
    },

    /** Fetch the current lock list from the server (socket-based with ack). */
    getLocks: (roomId: string): Promise<CodeLock[]> => {
      if (!socket || !socket.connected) return Promise.resolve([])

      return new Promise((resolve) => {
        let settled = false
        const complete = (locks: CodeLock[]) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          socket.off('locks-state', onLocksState)
          resolve(locks)
        }

        const onLocksState = (data: { locks: CodeLock[] }) => {
          complete(data?.locks || [])
        }

        socket.once('locks-state', onLocksState)

        const timeout = setTimeout(() => {
          complete([])
        }, 3000)

        socket.emit(
          'get-locks',
          { roomId },
          (response: { ok: boolean; locks?: CodeLock[] }) => {
            if (!response?.ok) {
              return
            }
            complete(response.locks || [])
          }
        )
      })
    },

    /** Subscribe to lock-assigned events broadcast by the server. */
    onLockAssigned: (callback: (lock: CodeLock) => void) => {
      if (socket) {
        socket.on('lock-assigned', callback)
        return () => socket.off('lock-assigned', callback)
      }
      return () => {}
    },

    /** Subscribe to lock-removed events broadcast by the server. */
    onLockRemoved: (callback: (data: { lockId: string }) => void) => {
      if (socket) {
        socket.on('lock-removed', callback)
        return () => socket.off('lock-removed', callback)
      }
      return () => {}
    },

    /** Subscribe to lock-violation events for blocked edits. */
    onLockViolation: (callback: (data: { filePath: string; message: string }) => void) => {
      if (socket) {
        socket.on('lock-violation', callback)
        return () => socket.off('lock-violation', callback)
      }
      return () => {}
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
