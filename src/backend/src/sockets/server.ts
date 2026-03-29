import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import { Server, Socket } from 'socket.io'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWSConnection } = require('y-websocket/bin/utils')

const app = express()
const server = http.createServer(app)

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

interface ChatMessage {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: number
  isSystem?: boolean
}

interface Room {
  users: Map<string, { id: string; name: string }>
  changes: FileChange[]
  projectPath?: string
  fileTree?: any[]
  messages: ChatMessage[]
  drawings: any[] // whiteboard elements
  clearSeq: number // monotonically-increasing clear generation
}

interface SocketData {
  userName?: string
  roomId?: string
}

const rooms = new Map<string, Room>()
const DEBOUNCE_MS = 1000

const io = new Server<any, any, any, SocketData>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

function computeLineChanges(oldContent: string, newContent: string): FileChange['lineChanges'] {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const changes: FileChange['lineChanges'] = []
  const maxLen = Math.max(oldLines.length, newLines.length)

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine === undefined && newLine !== undefined) {
      changes.push({ line: i + 1, type: 'add', content: newLine })
    } else if (oldLine !== undefined && newLine === undefined) {
      changes.push({ line: i + 1, type: 'remove', content: oldLine })
    } else if (oldLine !== newLine) {
      changes.push({ line: i + 1, type: 'modify', content: newLine || '' })
    }
  }

  return changes
}

io.on('connection', (socket: Socket<any, any, any, SocketData>) => {
  console.log(`New User connected: ${socket.id}`)

  socket.on('join-room', ({ roomId, userName }: { roomId: string; userName: string }) => {
    socket.join(roomId)
    socket.data.userName = userName
    socket.data.roomId = roomId

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        changes: [],
        messages: [],
        drawings: [],
        clearSeq: 0
      })
    }

    const room = rooms.get(roomId)!
    room.users.set(socket.id, { id: socket.id, name: userName })

    socket.to(roomId).emit('user-joined', { userId: socket.id, userName })
    socket.emit('room-users', Array.from(room.users.values()))
    socket.emit('load-canvas', { drawings: room.drawings, clearSeq: room.clearSeq })
  })

  socket.on(
    'code-change',
    ({
      roomId,
      filePath,
      newCode,
      oldCode,
      userName
    }: {
      roomId: string
      filePath: string
      newCode: string
      oldCode: string
      userName: string
    }) => {
      if (!rooms.has(roomId)) return

      const room = rooms.get(roomId)!
      const resolvedName = userName || socket.data.userName || 'Anonymous'
      const now = Date.now()

      const lastChangeIdx = room.changes.findLastIndex(
        (c) => c.filePath === filePath && c.userId === socket.id
      )
      const lastChange = lastChangeIdx !== -1 ? room.changes[lastChangeIdx] : null

      if (lastChange && now - lastChange.timestamp < DEBOUNCE_MS) {
        lastChange.newContent = newCode
        lastChange.timestamp = now
        lastChange.lineChanges = computeLineChanges(lastChange.oldContent, newCode)
        socket.to(roomId).emit('code-update', { filePath, code: newCode })
        socket.to(roomId).emit('change-made', lastChange)
        return
      }

      const lineChanges = computeLineChanges(oldCode || '', newCode)
      const change: FileChange = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        filePath,
        userId: socket.id,
        userName: resolvedName,
        timestamp: now,
        oldContent: oldCode || '',
        newContent: newCode,
        lineChanges
      }

      room.changes.push(change)

      const fileChanges = room.changes.filter((c) => c.filePath === filePath)
      if (fileChanges.length > 50) {
        const oldestId = fileChanges[0].id
        const idx = room.changes.findIndex((c) => c.id === oldestId)
        if (idx !== -1) room.changes.splice(idx, 1)
      }

      socket.to(roomId).emit('code-update', { filePath, code: newCode })
      socket.to(roomId).emit('change-made', change)
    }
  )

  socket.on('get-changes', ({ roomId, filePath }: { roomId: string; filePath: string }) => {
    if (!rooms.has(roomId)) {
      socket.emit('file-changes', { filePath, changes: [] })
      return
    }
    const room = rooms.get(roomId)!
    const fileChanges = room.changes.filter((c) => c.filePath === filePath).slice(-20)
    socket.emit('file-changes', { filePath, changes: fileChanges })
  })

  socket.on('get-all-changes', ({ roomId }: { roomId: string }) => {
    if (!rooms.has(roomId)) {
      socket.emit('all-changes', { changes: [] })
      return
    }
    const room = rooms.get(roomId)!
    socket.emit('all-changes', { changes: room.changes.slice(-50) })
  })

  socket.on(
    'share-project',
    ({
      roomId,
      projectPath,
      fileTree
    }: {
      roomId: string
      projectPath: string
      fileTree: any[]
    }) => {
      if (!rooms.has(roomId)) return
      const room = rooms.get(roomId)!
      room.projectPath = projectPath
      room.fileTree = fileTree
      socket.to(roomId).emit('project-shared', { projectPath, fileTree })
    }
  )

  socket.on('get-project', ({ roomId }: { roomId: string }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    if (room.projectPath) {
      socket.emit('project-shared', {
        projectPath: room.projectPath,
        fileTree: room.fileTree || []
      })
    }
  })

  socket.on('chat-message', ({ roomId, content }: { roomId: string; content: string }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    const user = room.users.get(socket.id)
    if (!user) return

    const message: ChatMessage = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      userId: socket.id,
      userName: user.name,
      content,
      timestamp: Date.now()
    }

    room.messages.push(message)
    if (room.messages.length > 100) room.messages = room.messages.slice(-100)

    socket.to(roomId).emit('chat-message', message)
    socket.emit('chat-message-sent', message)
  })

  socket.on('get-chat-history', ({ roomId }: { roomId: string }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    socket.emit('chat-history', { messages: room.messages.slice(-50) })
  })

  // --- WHITEBOARD EVENTS ---

  socket.on('draw-action', ({ roomId, drawData }: { roomId: string; drawData: any }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    // Reject draws that belong to a previous clear generation
    if ((drawData.clearSeq ?? 0) < room.clearSeq) return
    room.drawings.push(drawData)
    socket.to(roomId).emit('receive-draw', drawData)
  })

  socket.on('clear-canvas', ({ roomId }: { roomId: string }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    room.clearSeq += 1
    room.drawings = []
    // Broadcast to all including sender so every client updates their clearSeq
    io.to(roomId).emit('canvas-cleared', { clearSeq: room.clearSeq })
  })

  socket.on(
    'cursor-move',
    ({
      roomId,
      pointer,
      userName
    }: {
      roomId: string
      pointer: { x: number; y: number }
      userName: string
    }) => {
      socket.to(roomId).emit('cursor-update', { socketId: socket.id, pointer, userName })
    }
  )

  // --------------------------
  // ── NEW: assign a file to a user ──────────────────────────────────────────
  socket.on(
    'assign-file',
    ({
      roomId,
      filePath,
      assigneeId,
      assigneeName,
      message
    }: {
      roomId: string
      filePath: string
      assigneeId: string
      assigneeName: string
      message?: string
    }) => {
      if (!rooms.has(roomId)) return
      const room = rooms.get(roomId)!
      const assigner = room.users.get(socket.id)
      if (!assigner) return

      console.log('assign-file received:', { roomId, filePath, assigneeId, assigneeName, message })

      const fileName = filePath.split('/').pop() ?? filePath

      let content = `📌 "${fileName}" has been assigned to ${assigneeName} by ${assigner.name}`
      if (message && message.trim()) {
        content += `\n💬 "${message.trim()}"`
      }

      const systemMessage: ChatMessage = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        userId: 'system',
        userName: 'system',
        content,
        timestamp: Date.now(),
        isSystem: true
      }

      room.messages.push(systemMessage)
      if (room.messages.length > 100) room.messages = room.messages.slice(-100)

      // broadcast to everyone in room including sender
      console.log('Emitting chat-message:', systemMessage)
      io.to(roomId).emit('chat-message', systemMessage)
      io.to(roomId).emit('file-assigned', {
        filePath,
        assigneeId,
        assigneeName,
        assignedBy: assigner.name
      })
    }
  )

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        const user = room.users.get(socket.id)!
        room.users.delete(socket.id)
        socket.to(roomId).emit('user-left', user)
      }
    })
    console.log(`User disconnected: ${socket.id}`)
  })
})

const PORT = 5002
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})

// ── Yjs WebSocket relay on port 5003 ─────────────────────────────────────────
// Acts as a simple relay — Yjs handles all CRDT merge logic client-side
const yjsHttpServer = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end('Yjs WS relay')
})

const wss = new WebSocketServer({ server: yjsHttpServer })

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req)
})

const YJS_PORT = 5003
yjsHttpServer.listen(YJS_PORT, () => {
  console.log(`Yjs WebSocket relay listening on port ${YJS_PORT}`)
})
