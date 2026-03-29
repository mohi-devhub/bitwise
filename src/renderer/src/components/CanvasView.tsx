import { useEffect, useRef, useState } from 'react'
import { MousePointer2, Pencil, Square, Circle, Minus, Type, Layers, Trash2, Download } from 'lucide-react'
import { io, Socket } from 'socket.io-client'

const SHAPE_TOOLS   = ['Square', 'Circle', 'Minus']
const DRAWING_TOOLS = ['Pencil', 'Square', 'Circle', 'Minus']
const COLORS = ['#ffffff', '#ff4d4f', '#ffa940', '#fadb14', '#73d13d', '#40a9ff', '#9254de']

export const CanvasView = ({ roomId = 'hackathon-room', userName = 'Dev' }) => {
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const gridRef        = useRef<HTMLDivElement>(null)
  const socketRef      = useRef<Socket | null>(null)
  const drawingsRef    = useRef<any[]>([])
  
  // NEW: History Stacks for Undo / Redo!
  const historyStack   = useRef<{ type: 'add' | 'update' | 'delete', obj: any, oldObj?: any }[]>([])
  const redoStack      = useRef<{ type: 'add' | 'update' | 'delete', obj: any, oldObj?: any }[]>([])
  
  const cameraRef      = useRef({ x: 0, y: 0, z: 1 })
  const pendingShapeRef= useRef<any>(null)
  
  const startPosRef    = useRef({ x: 0, y: 0 })
  const isDrawingRef   = useRef(false)
  const activeToolRef  = useRef('Pencil')
  const lastPosRef     = useRef({ x: 0, y: 0 })
  const clearSeqRef    = useRef(0)

  const [activeTool, setActiveTool] = useState('Pencil')
  const [activeColor, setActiveColor] = useState('#ffffff')
  
  // Track floating text input (includes ID for editing)
  const [textInput, setTextInput] = useState<{ id?: string; x: number; y: number; text: string; color: string } | null>(null)
  
  // Track the object currently being dragged (now stores the original state for Undo tracking)
  const [draggingObject, setDraggingObject] = useState<{ id: string; offsetX: number; offsetY: number, originalObj: any } | null>(null)

  const setTool = (tool: string) => {
    setActiveTool(tool)
    activeToolRef.current = tool
  }

  const tools = [
    { icon: MousePointer2, name: 'Select' },
    { icon: Pencil,        name: 'Pencil' },
    { icon: Square,        name: 'Square' },
    { icon: Circle,        name: 'Circle' },
    { icon: Minus,         name: 'Minus'  },
    { icon: Type,          name: 'Type'   },
    { icon: Layers,        name: 'Layers' }
  ]

  // --- MATH & HIT DETECTION ---
  const getWorldPos = (screenX: number, screenY: number) => {
    return {
      x: (screenX - cameraRef.current.x) / cameraRef.current.z,
      y: (screenY - cameraRef.current.y) / cameraRef.current.z
    }
  }

  const getObjectAtPosition = (worldX: number, worldY: number) => {
    // Loop backwards to grab the top-most object first
    for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
      const d = drawingsRef.current[i]
      
      // Hit detection for Text Boxes
      if (d.tool === 'Type') {
        const lines = d.text.split('\n')
        const height = lines.length * 30
        const maxWidth = Math.max(...lines.map((l: string) => l.length * 14))
        
        // Pad the bounding box by 15px so it's easy to grab the border!
        if (
          worldX >= d.x0 - 15 && worldX <= d.x0 + maxWidth + 15 &&
          worldY >= d.y0 - 15 && worldY <= d.y0 + height + 15
        ) {
          return d
        }
      }
      // Basic bounding box for shapes
      else if (d.tool === 'Square' || d.tool === 'Circle') {
        const minX = Math.min(d.x0, d.x1)
        const maxX = Math.max(d.x0, d.x1)
        const minY = Math.min(d.y0, d.y1)
        const maxY = Math.max(d.y0, d.y1)
        if (worldX >= minX && worldX <= maxX && worldY >= minY && worldY <= maxY) {
          return d
        }
      }
    }
    return null
  }

  const updateGrid = () => {
    if (!gridRef.current) return
    const { x, y, z } = cameraRef.current
    gridRef.current.style.backgroundPosition = `${x}px ${y}px`
    gridRef.current.style.backgroundSize = `${40 * z}px ${40 * z}px`
  }

  // --- RENDER ENGINE ---
  const applyDrawData = (ctx: CanvasRenderingContext2D, d: any) => {
    // Hide the text if it's currently being actively edited in the HTML box
    if (d.tool === 'Type' && textInput?.id === d.id) return

    ctx.strokeStyle = d.color || '#ffffff'
    ctx.fillStyle   = d.color || '#ffffff'
    ctx.lineWidth   = 2
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'

    const tool = d.tool ?? 'Pencil'

    if (tool === 'Pencil' || tool === 'Minus') {
      ctx.beginPath()
      ctx.moveTo(d.x0, d.y0)
      ctx.lineTo(d.x1, d.y1)
      ctx.stroke()
      ctx.closePath()
    } else if (tool === 'Square') {
      ctx.beginPath()
      ctx.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0)
    } else if (tool === 'Circle') {
      const rx = Math.abs(d.x1 - d.x0) / 2
      const ry = Math.abs(d.y1 - d.y0) / 2
      const cx = (d.x0 + d.x1) / 2
      const cy = (d.y0 + d.y1) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (tool === 'Type') {
      ctx.font = '24px sans-serif'
      ctx.textBaseline = 'top'
      const lines = d.text.split('\n')
      lines.forEach((line: string, index: number) => {
        ctx.fillText(line, d.x0, d.y0 + (index * 30))
      })
    }
  }

  const renderFrame = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()

    ctx.save()
    ctx.translate(cameraRef.current.x, cameraRef.current.y)
    ctx.scale(cameraRef.current.z, cameraRef.current.z)

    drawingsRef.current.forEach((d) => applyDrawData(ctx, d))
    if (pendingShapeRef.current) applyDrawData(ctx, pendingShapeRef.current)

    ctx.restore()
  }

  // --- UNDO / REDO LOGIC ---
  const handleUndo = () => {
    const lastAction = historyStack.current.pop()
    if (!lastAction) return
    redoStack.current.push(lastAction)

    if (lastAction.type === 'add') {
      // Revert an Add -> Delete it
      const idx = drawingsRef.current.findIndex(d => d.id === lastAction.obj.id)
      if (idx !== -1) drawingsRef.current.splice(idx, 1)
      socketRef.current?.emit('draw-action', { roomId, drawData: { id: lastAction.obj.id, action: 'delete' } })
    } else if (lastAction.type === 'update') {
      // Revert an Update -> Restore old object
      const idx = drawingsRef.current.findIndex(d => d.id === lastAction.obj.id)
      if (idx !== -1 && lastAction.oldObj) {
        drawingsRef.current[idx] = lastAction.oldObj
        socketRef.current?.emit('draw-action', { roomId, drawData: { ...lastAction.oldObj, action: 'update' } })
      }
    }
    renderFrame()
  }

  const handleRedo = () => {
    const lastUndo = redoStack.current.pop()
    if (!lastUndo) return
    historyStack.current.push(lastUndo)

    if (lastUndo.type === 'add') {
      drawingsRef.current.push(lastUndo.obj)
      socketRef.current?.emit('draw-action', { roomId, drawData: { ...lastUndo.obj, action: 'add' } })
    } else if (lastUndo.type === 'update') {
      const idx = drawingsRef.current.findIndex(d => d.id === lastUndo.obj.id)
      if (idx !== -1) {
        drawingsRef.current[idx] = lastUndo.obj
        socketRef.current?.emit('draw-action', { roomId, drawData: { ...lastUndo.obj, action: 'update' } })
      }
    }
    renderFrame()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger undo if typing in a text box
      if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT') return

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) handleRedo()
        else handleUndo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // --- SOCKET SYNC ---
  useEffect(() => {
    const socket = io('http://localhost:5002')
    socketRef.current = socket
    socket.emit('join-room', { roomId, userName })

    socket.on('load-canvas', ({ drawings, clearSeq }: { drawings: any[]; clearSeq: number }) => {
      clearSeqRef.current = clearSeq
      const stateMap = new Map()
      drawings.forEach(d => {
        if (d.action === 'delete') stateMap.delete(d.id)
        else stateMap.set(d.id, d)
      })
      drawingsRef.current = Array.from(stateMap.values())
      renderFrame()
    })

    socket.on('receive-draw', (drawData: any) => {
      if ((drawData.clearSeq ?? 0) < clearSeqRef.current) return
      
      if (drawData.action === 'delete') {
        const idx = drawingsRef.current.findIndex(d => d.id === drawData.id)
        if (idx !== -1) drawingsRef.current.splice(idx, 1)
      } else if (drawData.action === 'update') {
        const idx = drawingsRef.current.findIndex(d => d.id === drawData.id)
        if (idx !== -1) drawingsRef.current[idx] = drawData
      } else {
        drawingsRef.current.push(drawData)
      }
      renderFrame()
    })

    socket.on('canvas-cleared', ({ clearSeq }: { clearSeq: number }) => {
      clearSeqRef.current = clearSeq
      drawingsRef.current = []
      pendingShapeRef.current = null
      renderFrame()
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [roomId, userName])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const setSize = () => {
      canvas.width  = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
      renderFrame()
    }
    setSize()
    const observer = new ResizeObserver(setSize)
    observer.observe(canvas)

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault() 
      const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1
      const newZ = Math.min(Math.max(cameraRef.current.z * zoomDelta, 0.1), 10) 
      const mouseX = e.offsetX
      const mouseY = e.offsetY
      cameraRef.current.x = mouseX - (mouseX - cameraRef.current.x) * (newZ / cameraRef.current.z)
      cameraRef.current.y = mouseY - (mouseY - cameraRef.current.y) * (newZ / cameraRef.current.z)
      cameraRef.current.z = newZ
      updateGrid()
      renderFrame()
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      observer.disconnect()
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [])

  // --- ACTIONS ---
  const handleClearCanvas = () => {
    drawingsRef.current = []
    historyStack.current = [] // Wipe history on clear
    redoStack.current = []
    pendingShapeRef.current = null
    renderFrame()
    socketRef.current?.emit('clear-canvas', { roomId })
  }

  const handleDownload = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = canvas.width
    tempCanvas.height = canvas.height
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) return
    tempCtx.fillStyle = '#0f0f0f'
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height)
    tempCtx.drawImage(canvas, 0, 0)
    const a = document.createElement('a')
    a.href = tempCanvas.toDataURL('image/png')
    a.download = `bitwise-whiteboard-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const saveText = () => {
    if (textInput) {
      if (textInput.text.trim()) {
        const isUpdate = !!textInput.id
        const drawData = {
          id: textInput.id || Date.now().toString(36) + Math.random().toString(36).substr(2),
          tool: 'Type',
          action: isUpdate ? 'update' : 'add',
          x0: textInput.x,
          y0: textInput.y,
          text: textInput.text,
          color: textInput.color,
          clearSeq: clearSeqRef.current
        }

        if (isUpdate) {
          const idx = drawingsRef.current.findIndex(d => d.id === drawData.id)
          const oldObj = drawingsRef.current[idx]
          if (idx !== -1) drawingsRef.current[idx] = drawData
          historyStack.current.push({ type: 'update', obj: drawData, oldObj })
        } else {
          drawingsRef.current.push(drawData)
          historyStack.current.push({ type: 'add', obj: drawData })
        }
        
        redoStack.current = [] // Clear redo
        socketRef.current?.emit('draw-action', { roomId, drawData })
      } else if (textInput.id) {
        // If they deleted all the text from an existing box, delete it entirely
        const idx = drawingsRef.current.findIndex(d => d.id === textInput.id)
        if (idx !== -1) drawingsRef.current.splice(idx, 1)
        socketRef.current?.emit('draw-action', { roomId, drawData: { id: textInput.id, action: 'delete' } })
      }
      renderFrame()
    }
    setTextInput(null)
  }

  // --- POINTER EVENTS ---
  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const tool = activeToolRef.current
    const { offsetX, offsetY } = e.nativeEvent
    const worldPos = getWorldPos(offsetX, offsetY)

    // Save open text if clicking away
    if (textInput) {
      saveText()
      // If we are in Text mode, spawn a new box right away
      if (tool === 'Type') {
         setTextInput({ x: worldPos.x, y: worldPos.y, text: '', color: activeColor })
      }
      return
    }

    if (tool !== 'Type') {
      e.currentTarget.setPointerCapture(e.pointerId) 
    }

    if (tool === 'Select') {
      const obj = getObjectAtPosition(worldPos.x, worldPos.y)
      if (obj) {
        // Start dragging the object!
        setDraggingObject({ 
          id: obj.id, 
          offsetX: worldPos.x - obj.x0, 
          offsetY: worldPos.y - (obj.y0 || 0), // Account for tools that might use y0 differently
          originalObj: { ...obj } 
        })
      } else {
        lastPosRef.current = { x: offsetX, y: offsetY }
      }
      return
    }

    if (tool === 'Type') {
      setTextInput({ x: worldPos.x, y: worldPos.y, text: '', color: activeColor })
      return
    }

    if (!DRAWING_TOOLS.includes(tool)) return

    isDrawingRef.current = true
    lastPosRef.current = worldPos
    startPosRef.current = worldPos
  }

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const tool = activeToolRef.current
    const { offsetX, offsetY } = e.nativeEvent
    const worldPos = getWorldPos(offsetX, offsetY)

    if (tool === 'Select') {
      if (draggingObject) {
        const idx = drawingsRef.current.findIndex(d => d.id === draggingObject.id)
        if (idx !== -1) {
          const updatedObj = { 
            ...drawingsRef.current[idx], 
            // Calculate new position based on the original grab offset
            x0: worldPos.x - draggingObject.offsetX, 
            y0: worldPos.y - draggingObject.offsetY,
            // If it's a shape with an x1/y1, shift them equally to preserve size!
            x1: drawingsRef.current[idx].x1 ? drawingsRef.current[idx].x1 + (worldPos.x - draggingObject.offsetX - drawingsRef.current[idx].x0) : undefined,
            y1: drawingsRef.current[idx].y1 ? drawingsRef.current[idx].y1 + (worldPos.y - draggingObject.offsetY - drawingsRef.current[idx].y0) : undefined,
            action: 'update'
          }
          drawingsRef.current[idx] = updatedObj
          
          socketRef.current?.emit('draw-action', { roomId, drawData: updatedObj })
          renderFrame()
        }
      } else if (e.buttons === 1) {
        cameraRef.current.x += (offsetX - lastPosRef.current.x)
        cameraRef.current.y += (offsetY - lastPosRef.current.y)
        lastPosRef.current = { x: offsetX, y: offsetY }
        updateGrid()
        renderFrame()
      }
      return
    }

    if (!isDrawingRef.current) return

    if (tool === 'Pencil') {
      const drawData = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        tool: 'Pencil',
        color: activeColor,
        x0: lastPosRef.current.x,
        y0: lastPosRef.current.y,
        x1: worldPos.x,
        y1: worldPos.y,
        clearSeq: clearSeqRef.current,
        action: 'add'
      }
      drawingsRef.current.push(drawData)
      historyStack.current.push({ type: 'add', obj: drawData })
      redoStack.current = []
      
      socketRef.current?.emit('draw-action', { roomId, drawData })
      lastPosRef.current = worldPos
      renderFrame()
    } else if (SHAPE_TOOLS.includes(tool)) {
      pendingShapeRef.current = { 
        id: pendingShapeRef.current?.id || Date.now().toString(36) + Math.random().toString(36).substr(2),
        tool, 
        color: activeColor,
        x0: startPosRef.current.x, 
        y0: startPosRef.current.y, 
        x1: worldPos.x, 
        y1: worldPos.y,
        action: 'add'
      }
      renderFrame()
    }
  }

  const stopDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    
    if (draggingObject) {
      // Save the move to history stack!
      const currentObj = drawingsRef.current.find(d => d.id === draggingObject.id)
      if (currentObj && (currentObj.x0 !== draggingObject.originalObj.x0 || currentObj.y0 !== draggingObject.originalObj.y0)) {
        historyStack.current.push({ type: 'update', obj: currentObj, oldObj: draggingObject.originalObj })
        redoStack.current = []
      }
      setDraggingObject(null)
      return
    }

    if (!isDrawingRef.current) return
    isDrawingRef.current = false

    const tool = activeToolRef.current

    if (SHAPE_TOOLS.includes(tool) && pendingShapeRef.current) {
      const drawData = { ...pendingShapeRef.current, clearSeq: clearSeqRef.current }
      drawingsRef.current.push(drawData)
      historyStack.current.push({ type: 'add', obj: drawData })
      redoStack.current = []
      
      socketRef.current?.emit('draw-action', { roomId, drawData })
      pendingShapeRef.current = null
      renderFrame()
    }
  }

  // DOUBLE CLICK TO EDIT TEXT
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeToolRef.current !== 'Select') return
    const { nativeEvent } = e
    const worldPos = getWorldPos(nativeEvent.offsetX, nativeEvent.offsetY)
    
    const obj = getObjectAtPosition(worldPos.x, worldPos.y)
    if (obj && obj.tool === 'Type') {
      setTextInput({ id: obj.id, x: obj.x0, y: obj.y0, text: obj.text, color: obj.color || '#ffffff' })
      renderFrame()
    }
  }

  return (
    <div className="flex-1 w-full h-full bg-island border border-border rounded-island shadow-2xl relative overflow-hidden flex items-center justify-center group">
      
      {/* Left Toolbar */}
      <div className="absolute top-6 left-6 flex flex-col space-y-4 z-20">
        
        {/* Main Tools */}
        <div className="bg-black/60 border border-border backdrop-blur-xl p-1.5 rounded-2xl flex flex-col space-y-1 shadow-2xl">
          {tools.map((tool) => (
            <button
              key={tool.name}
              onClick={() => setTool(tool.name)}
              className={`p-2.5 rounded-xl transition-all ${
                activeTool === tool.name
                  ? 'bg-white text-black shadow-lg shadow-white/10 scale-105'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
              title={tool.name}
            >
              <tool.icon size={18} strokeWidth={activeTool === tool.name ? 2.5 : 2} />
            </button>
          ))}

          <div className="w-full h-px bg-border my-1 opacity-50" />

          <button
            onClick={handleClearCanvas}
            className="p-2.5 rounded-xl transition-all text-red-400 hover:text-white hover:bg-red-500/80"
            title="Clear Canvas"
          >
            <Trash2 size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Color Palette */}
        <div className="bg-black/60 border border-border backdrop-blur-xl p-2 rounded-2xl flex flex-col items-center gap-2 shadow-2xl">
          {COLORS.map((color) => (
            <button
              key={color}
              onClick={() => setActiveColor(color)}
              className={`w-6 h-6 rounded-full transition-transform ${
                activeColor === color ? 'ring-2 ring-white scale-110' : 'hover:scale-110'
              }`}
              style={{ backgroundColor: color }}
              title="Select Color"
            />
          ))}
        </div>
      </div>

      {/* Right Toolbar */}
      <div className="absolute top-6 right-6 bg-black/60 border border-border backdrop-blur-xl p-1.5 rounded-2xl flex flex-col space-y-1 z-20 shadow-2xl">
        <button
          onClick={handleDownload}
          className="p-2.5 rounded-xl transition-all text-gray-400 hover:text-white hover:bg-white/5"
          title="Download Canvas"
        >
          <Download size={18} strokeWidth={2} />
        </button>
      </div>

      <div
        ref={gridRef}
        className="absolute inset-0 opacity-10 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, #ffffff 1px, transparent 0)',
          backgroundSize: '40px 40px',
          backgroundPosition: '0px 0px'
        }}
      />

      {/* Floating Text Input overlay */}
      {textInput && (
        <textarea
          autoFocus
          value={textInput.text}
          onChange={(e) => setTextInput({ ...textInput, text: e.target.value })}
          onKeyDown={(e) => {
            // Let them type multiline, but prevent shortcuts inside the text box!
            e.stopPropagation()
          }}
          className="absolute z-50 bg-black/50 outline-none resize-none overflow-hidden whitespace-pre font-sans rounded-md p-1"
          placeholder="Type..."
          style={{
            left: textInput.x * cameraRef.current.z + cameraRef.current.x - 5,
            top: textInput.y * cameraRef.current.z + cameraRef.current.y - 5,
            fontSize: `${24 * cameraRef.current.z}px`,
            color: textInput.color,
            lineHeight: '30px',
            minWidth: '150px',
            minHeight: '40px',
            border: `1px dashed ${textInput.color}88`
          }}
        />
      )}

      <canvas
        ref={canvasRef}
        className="w-full h-full absolute inset-0 z-10 touch-none outline-none"
        tabIndex={0} // Allows canvas to capture keydown events easily!
        style={{ 
          cursor: activeTool === 'Select' 
            ? (draggingObject ? 'grabbing' : 'pointer') 
            : (activeTool === 'Type' ? 'text' : (DRAWING_TOOLS.includes(activeTool) ? 'crosshair' : 'default')) 
        }}
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={stopDrawing}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  )
}