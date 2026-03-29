import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import { Server, Socket } from 'socket.io'
import { getDb } from '../db/connection'
import { runMigrations } from '../db/schema'
import { send400, send403, send404, send500, sendOk } from '../utils/response'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWSConnection } = require('y-websocket/bin/utils')

const app = express()
app.use(express.json())

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

interface CodeLock {
  id: string
  filePath: string
  memberId: string
  memberName: string
  startLine: number
  endLine: number
  assignedAt: number
}

interface DbCodeLock {
  [key: string]: unknown
  id: string
  room_id: string
  file_id?: string
  file_path?: string
  member_id: string
  member_name?: string
  start_line: number
  end_line: number
  locked_at: number
}

interface Room {
  users: Map<string, { id: string; name: string }>
  changes: FileChange[]
  projectPath?: string
  fileTree?: any[]
  messages: ChatMessage[]
  drawings: any[]
  clearSeq: number
  hostSocketId: string
  locks: Map<string, CodeLock>
}

interface SocketData {
  userName?: string
  roomId?: string
}

const rooms = new Map<string, Room>()
const DEBOUNCE_MS = 1000
const dbReady = (async () => {
  await getDb()
  await runMigrations()
})()

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

function makeId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9)
}

function fromDbLock(row: DbCodeLock): CodeLock {
  return {
    id: row.id,
    filePath: row.file_id || row.file_path || '',
    memberId: row.member_id,
    memberName: row.member_name || 'Unknown',
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    assignedAt: Number(row.locked_at)
  }
}

async function ensureRoomExists(roomCode: string): Promise<void> {
  await dbReady
  const db = await getDb()
  const existing = await db.get<{ id: string }>('SELECT id FROM rooms WHERE code = ? LIMIT 1', [roomCode])
  if (existing) return

  const now = Date.now()
  await db.run(
    `INSERT INTO rooms (id, code, name, created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [roomCode, roomCode, `Room ${roomCode}`, now, now]
  )
}

async function getLocksForRoom(roomCode: string): Promise<CodeLock[]> {
  await dbReady
  const db = await getDb()
  const rows = await db.all<DbCodeLock>(
    `SELECT id, room_id, file_id, file_path, member_id, member_name, start_line, end_line, locked_at
     FROM code_locks
     WHERE room_id = ?
     ORDER BY locked_at ASC`,
    [roomCode]
  )
  return rows.map(fromDbLock)
}

async function saveLock(roomCode: string, lock: CodeLock): Promise<void> {
  await dbReady
  const db = await getDb()
  await db.run(
    `INSERT INTO code_locks (
      id, room_id, file_id, file_path, member_id, member_name, start_line, end_line, locked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lock.id,
      roomCode,
      lock.filePath,
      lock.filePath,
      lock.memberId,
      lock.memberName,
      lock.startLine,
      lock.endLine,
      lock.assignedAt
    ]
  )
}

async function deleteLock(roomCode: string, lockId: string): Promise<void> {
  await dbReady
  const db = await getDb()
  await db.run('DELETE FROM code_locks WHERE room_id = ? AND id = ?', [roomCode, lockId])
}

async function deleteMemberLocks(roomCode: string, memberId: string): Promise<string[]> {
  await dbReady
  const db = await getDb()
  const rows = await db.all<{ id: string }>('SELECT id FROM code_locks WHERE room_id = ? AND member_id = ?', [
    roomCode,
    memberId
  ])
  await db.run('DELETE FROM code_locks WHERE room_id = ? AND member_id = ?', [roomCode, memberId])
  return rows.map((r) => r.id)
}

function hasLineOverlap(lock: CodeLock, startLine: number, endLine: number): boolean {
  return !(endLine < lock.startLine || startLine > lock.endLine)
}

function isLineInAnyRange(line: number, ranges: CodeLock[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine)
}

function canApplyChange(
  room: Room,
  socketId: string,
  filePath: string,
  lineChanges: FileChange['lineChanges']
): boolean {
  if (lineChanges.length === 0) return true

  const fileLocks = Array.from(room.locks.values()).filter((l) => l.filePath === filePath)
  if (fileLocks.length === 0) return true

  const myLocks = fileLocks.filter((l) => l.memberId === socketId)
  if (myLocks.length > 0) {
    return lineChanges.every((c) => isLineInAnyRange(c.line, myLocks))
  }

  const protectedLines = fileLocks.filter((l) => l.memberId !== socketId)
  return lineChanges.every((c) => !isLineInAnyRange(c.line, protectedLines))
}

function ensureValidHost(room: Room, preferredSocketId?: string): void {
  if (room.users.has(room.hostSocketId)) return

  if (preferredSocketId && room.users.has(preferredSocketId)) {
    room.hostSocketId = preferredSocketId
    return
  }

  const nextHostId = room.users.keys().next().value as string | undefined
  if (nextHostId) {
    room.hostSocketId = nextHostId
  }
}

async function clearOverlappingLocks(roomCode: string, room: Room, filePath: string, startLine: number, endLine: number) {
  const overlappingIds: string[] = []
  room.locks.forEach((existingLock, existingId) => {
    if (existingLock.filePath !== filePath) return
    if (hasLineOverlap(existingLock, startLine, endLine)) {
      overlappingIds.push(existingId)
    }
  })

  for (const lockId of overlappingIds) {
    room.locks.delete(lockId)
    await deleteLock(roomCode, lockId)
    io.to(roomCode).emit('lock-removed', { lockId })
  }
}

// ── REST: GET /api/rooms/:code/locks ────────────────────────────────────────
app.get('/api/rooms/:code/locks', async (req, res) => {
  try {
    const { code } = req.params
    await ensureRoomExists(code)
    const locks = await getLocksForRoom(code)
    sendOk(res, { locks })
  } catch (error) {
    send500(res, 'Failed to fetch locks')
  }
})

// ── REST: POST /api/rooms/:code/locks ───────────────────────────────────────
// Body: { socketId, filePath, memberId, memberName, startLine, endLine }
app.post('/api/rooms/:code/locks', async (req, res) => {
  const room = rooms.get(req.params.code)
  if (!room) {
    send404(res, 'Room not found')
    return
  }

  const { socketId, filePath, memberId, memberName, startLine, endLine } = req.body
  ensureValidHost(room, socketId)
  if (!socketId || socketId !== room.hostSocketId) {
    send403(res, 'Only the host can assign locks')
    return
  }
  if (!filePath || !memberId || !memberName || startLine == null || endLine == null) {
    send400(res, 'Missing required fields')
    return
  }

  const normalizedStart = Number(startLine)
  const normalizedEnd = Number(endLine)
  if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd) || normalizedStart < 1) {
    send400(res, 'Invalid line range')
    return
  }
  if (normalizedEnd < normalizedStart) {
    send400(res, 'endLine must be greater than or equal to startLine')
    return
  }

  try {
    await ensureRoomExists(req.params.code)
    await clearOverlappingLocks(req.params.code, room, filePath, normalizedStart, normalizedEnd)

    const lock: CodeLock = {
      id: makeId(),
      filePath,
      memberId,
      memberName,
      startLine: normalizedStart,
      endLine: normalizedEnd,
      assignedAt: Date.now()
    }

    room.locks.set(lock.id, lock)
    await saveLock(req.params.code, lock)
    io.to(req.params.code).emit('lock-assigned', lock)
    sendOk(res, { lock })
  } catch (error) {
    send500(res, 'Failed to assign lock')
  }
})

// ── REST: DELETE /api/rooms/:code/locks/:lockId ─────────────────────────────
// Body: { socketId }
app.delete('/api/rooms/:code/locks/:lockId', async (req, res) => {
  const room = rooms.get(req.params.code)
  if (!room) {
    send404(res, 'Room not found')
    return
  }

  const { socketId } = req.body
  ensureValidHost(room, socketId)
  if (!socketId || socketId !== room.hostSocketId) {
    send403(res, 'Only the host can remove locks')
    return
  }

  const { lockId } = req.params
  if (!room.locks.has(lockId)) {
    send404(res, 'Lock not found')
    return
  }

  try {
    room.locks.delete(lockId)
    await deleteLock(req.params.code, lockId)
    io.to(req.params.code).emit('lock-removed', { lockId })
    sendOk(res, { success: true })
  } catch (error) {
    send500(res, 'Failed to remove lock')
  }
})

// ─────────────────────────────────────────────────────────────────────────────

io.on('connection', (socket: Socket<any, any, any, SocketData>) => {
  console.log(`New User connected: ${socket.id}`)

  socket.on('join-room', async ({ roomId, userName }: { roomId: string; userName: string }) => {
    socket.join(roomId)
    socket.data.userName = userName
    socket.data.roomId = roomId

    const isNewRoom = !rooms.has(roomId)
    if (isNewRoom) {
      let existingLocks: CodeLock[] = []
      try {
        await ensureRoomExists(roomId)
        existingLocks = await getLocksForRoom(roomId)
      } catch (error) {
        console.error('Failed to load persisted locks:', error)
      }

      rooms.set(roomId, {
        users: new Map(),
        changes: [],
        messages: [],
        drawings: [],
        clearSeq: 0,
        hostSocketId: socket.id,
        locks: new Map(existingLocks.map((lock) => [lock.id, lock]))
      })
    }

    const room = rooms.get(roomId)!
    room.users.set(socket.id, { id: socket.id, name: userName })
    ensureValidHost(room, socket.id)

    // Tell this socket its identity and whether it's the host, plus existing locks
    socket.emit('room-joined', {
      socketId: socket.id,
      isHost: socket.id === room.hostSocketId,
      locks: Array.from(room.locks.values())
    })

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

      let lastChangeIdx = -1
      for (let idx = room.changes.length - 1; idx >= 0; idx--) {
        const changeAtIdx = room.changes[idx]
        if (changeAtIdx.filePath === filePath && changeAtIdx.userId === socket.id) {
          lastChangeIdx = idx
          break
        }
      }
      const lastChange = lastChangeIdx !== -1 ? room.changes[lastChangeIdx] : null

      if (lastChange && now - lastChange.timestamp < DEBOUNCE_MS) {
        lastChange.newContent = newCode
        lastChange.timestamp = now
        lastChange.lineChanges = computeLineChanges(lastChange.oldContent, newCode)
        if (!canApplyChange(room, socket.id, filePath, lastChange.lineChanges)) {
          socket.emit('lock-violation', {
            filePath,
            message: 'Edit blocked: this range is locked'
          })
          return
        }
        socket.to(roomId).emit('code-update', { filePath, code: newCode })
        socket.to(roomId).emit('change-made', lastChange)
        return
      }

      const lineChanges = computeLineChanges(oldCode || '', newCode)
      if (!canApplyChange(room, socket.id, filePath, lineChanges)) {
        socket.emit('lock-violation', {
          filePath,
          message: 'Edit blocked: this range is locked'
        })
        return
      }

      const change: FileChange = {
        id: makeId(),
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
      id: makeId(),
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
    if ((drawData.clearSeq ?? 0) < room.clearSeq) return
    room.drawings.push(drawData)
    socket.to(roomId).emit('receive-draw', drawData)
  })

  socket.on('clear-canvas', ({ roomId }: { roomId: string }) => {
    if (!rooms.has(roomId)) return
    const room = rooms.get(roomId)!
    room.clearSeq += 1
    room.drawings = []
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

  // ── assign a file to a user ───────────────────────────────────────────────
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
        id: makeId(),
        userId: 'system',
        userName: 'system',
        content,
        timestamp: Date.now(),
        isSystem: true
      }

      room.messages.push(systemMessage)
      if (room.messages.length > 100) room.messages = room.messages.slice(-100)

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

  // ── CODE LOCK EVENTS ──────────────────────────────────────────────────────

  // Host assigns a line-range lock to a member
  socket.on(
    'assign-lock',
    async ({
      roomId,
      filePath,
      memberId,
      memberName,
      startLine,
      endLine
    }: {
      roomId: string
      filePath: string
      memberId: string
      memberName: string
      startLine: number
      endLine: number
    }, ack?: (result: { ok: boolean; lock?: CodeLock; error?: string }) => void) => {
      if (!rooms.has(roomId)) {
        ack?.({ ok: false, error: 'Room not found' })
        return
      }
      const room = rooms.get(roomId)!
      ensureValidHost(room, socket.id)
      if (socket.id !== room.hostSocketId) {
        ack?.({ ok: false, error: 'Only the host can assign locks' })
        return
      }

      const normalizedStart = Number(startLine)
      const normalizedEnd = Number(endLine)
      if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) {
        ack?.({ ok: false, error: 'Invalid line range' })
        return
      }
      if (normalizedStart < 1 || normalizedEnd < normalizedStart) {
        ack?.({ ok: false, error: 'Invalid line range' })
        return
      }

      try {
        await ensureRoomExists(roomId)
        await clearOverlappingLocks(roomId, room, filePath, normalizedStart, normalizedEnd)

        const lock: CodeLock = {
          id: makeId(),
          filePath,
          memberId,
          memberName,
          startLine: normalizedStart,
          endLine: normalizedEnd,
          assignedAt: Date.now()
        }
        room.locks.set(lock.id, lock)
        await saveLock(roomId, lock)
        io.to(roomId).emit('lock-assigned', lock)
        ack?.({ ok: true, lock })
      } catch (error) {
        console.error('Failed to assign lock:', error)
        ack?.({ ok: false, error: 'Failed to assign lock' })
      }
    }
  )

  // Host removes a lock
  socket.on(
    'remove-lock',
    async (
      { roomId, lockId }: { roomId: string; lockId: string },
      ack?: (result: { ok: boolean; error?: string }) => void
    ) => {
      if (!rooms.has(roomId)) {
        ack?.({ ok: false, error: 'Room not found' })
        return
      }
    const room = rooms.get(roomId)!
    ensureValidHost(room, socket.id)
    if (socket.id !== room.hostSocketId) {
      ack?.({ ok: false, error: 'Only the host can remove locks' })
      return
    }

    if (!room.locks.has(lockId)) {
      ack?.({ ok: false, error: 'Lock not found' })
      return
    }
    try {
      room.locks.delete(lockId)
      await deleteLock(roomId, lockId)
      io.to(roomId).emit('lock-removed', { lockId })
      ack?.({ ok: true })
    } catch (error) {
      console.error('Failed to remove lock:', error)
      ack?.({ ok: false, error: 'Failed to remove lock' })
    }
    }
  )

  // Fetch current locks for a room
  socket.on(
    'get-locks',
    (
      { roomId }: { roomId: string },
      ack?: (result: { ok: boolean; locks?: CodeLock[]; error?: string }) => void
    ) => {
    if (!rooms.has(roomId)) {
      socket.emit('locks-state', { locks: [] })
      ack?.({ ok: true, locks: [] })
      return
    }
    const room = rooms.get(roomId)!
    const locks = Array.from(room.locks.values())
    socket.emit('locks-state', { locks })
    ack?.({ ok: true, locks })
    }
  )

  // ─────────────────────────────────────────────────────────────────────────

  socket.on('disconnect', async () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        // Remove all locks that were assigned TO this user and notify the room
        const removedLockIds: string[] = []
        room.locks.forEach((lock, lockId) => {
          if (lock.memberId === socket.id) {
            room.locks.delete(lockId)
            removedLockIds.push(lockId)
          }
        })

        for (const lockId of removedLockIds) {
          socket.to(roomId).emit('lock-removed', { lockId })
        }

        if (removedLockIds.length > 0) {
          try {
            await deleteMemberLocks(roomId, socket.id)
          } catch (error) {
            console.error('Failed to delete member locks on disconnect:', error)
          }
        }

        const user = room.users.get(socket.id)!
        room.users.delete(socket.id)
        ensureValidHost(room)
        socket.to(roomId).emit('user-left', user)
      }
    }
    console.log(`User disconnected: ${socket.id}`)
  })
})

const PORT = 5002
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})

// ── Yjs WebSocket relay on port 5003 ─────────────────────────────────────────
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
