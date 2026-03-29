import { useState } from 'react'
import { X, Copy, Check, Users, Shield, UserPlus } from 'lucide-react'

interface CollaborativeModalProps {
  onClose: () => void
  isOpen: boolean
  onRoomJoined?: (roomId: string, userName: string) => void
}

export const CollaborativeModal = ({ onClose, isOpen, onRoomJoined }: CollaborativeModalProps) => {
  const [roomCode, setRoomCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'select' | 'create' | 'join'>('select')
  const [userName, setUserName] = useState('')
  const [error, setError] = useState('')

  if (!isOpen) return null

  const handleCreateRoom = async () => {
    if (!userName.trim()) {
      setError('Please enter your name')
      return
    }

    const code = Math.random().toString(36).substring(2, 8).toUpperCase()
    setRoomCode(code)
    setError('')

    if (window.api.collab) {
      await window.api.collab.connect(code, userName)
      onRoomJoined?.(code, userName)
    }
  }

  const handleJoinRoom = async () => {
    if (!userName.trim()) {
      setError('Please enter your name')
      return
    }
    if (!joinCode.trim()) {
      setError('Please enter a room code')
      return
    }

    setError('')
    const code = joinCode.trim().toUpperCase()

    if (window.api.collab) {
      await window.api.collab.connect(code, userName)
      setRoomCode(code)
      onRoomJoined?.(code, userName)
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(roomCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-300">
      <div className="w-full max-w-md bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-300">
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-white/10 rounded-xl border border-white/10">
                <Users size={20} className="text-white" />
              </div>
              <h2 className="text-xl font-bold tracking-tight text-white">Collaboration</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-400 hover:text-white"
            >
              <X size={20} />
            </button>
          </div>

          {mode === 'select' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div
                  className="p-4 bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl flex flex-col items-center text-center space-y-3 cursor-pointer hover:border-blue-500/50 transition-colors"
                  onClick={() => setMode('create')}
                >
                  <Shield size={24} className="text-blue-400" />
                  <span className="text-xs font-medium text-gray-400">Create Room</span>
                </div>
                <div
                  className="p-4 bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl flex flex-col items-center text-center space-y-3 cursor-pointer hover:border-green-500/50 transition-colors"
                  onClick={() => setMode('join')}
                >
                  <UserPlus size={24} className="text-green-400" />
                  <span className="text-xs font-medium text-gray-400">Join Room</span>
                </div>
              </div>

              <div className="bg-[#1a1a1a] p-4 rounded-2xl border border-[#2a2a2a]">
                <p className="text-sm text-gray-400 leading-relaxed">
                  Invite your team to collaborate on code and design in real-time. Share your
                  session with a unique room code.
                </p>
              </div>
            </div>
          )}

          {(mode === 'create' || mode === 'join') && (
            <div className="space-y-4">
              <button
                onClick={() => {
                  setMode('select')
                  setError('')
                }}
                className="text-xs text-gray-500 hover:text-white flex items-center space-x-1"
              >
                <span>←</span>
                <span>Back</span>
              </button>

              <div className="space-y-2">
                <label className="text-xs text-gray-400">Your Name</label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Enter your name"
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-4 py-3 text-white placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {mode === 'join' && (
                <div className="space-y-2">
                  <label className="text-xs text-gray-400">Room Code</label>
                  <input
                    type="text"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="Enter room code"
                    maxLength={6}
                    className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-4 py-3 text-white placeholder-gray-500 outline-none focus:border-green-500 transition-colors font-mono tracking-widest"
                  />
                </div>
              )}

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                onClick={mode === 'create' ? handleCreateRoom : handleJoinRoom}
                className="w-full bg-white text-black font-bold py-4 rounded-xl hover:bg-gray-200 transition-all shadow-lg"
              >
                {mode === 'create' ? 'Create Room' : 'Join Room'}
              </button>
            </div>
          )}

          {roomCode && (
            <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500 mt-6 pt-6 border-t border-[#2a2a2a]">
              <div className="text-center space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-gray-500">
                  {mode === 'join' ? 'Joined Room' : 'Active Room'}
                </p>
                <div className="flex items-center justify-center space-x-3">
                  <div className="bg-[#1a1a1a] border-2 border-[#2a2a2a] px-6 py-3 rounded-2xl">
                    <span className="text-2xl font-mono font-black tracking-[0.3em] text-white">
                      {roomCode}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={copyToClipboard}
                  className="flex-1 flex items-center justify-center space-x-2 bg-[#1a1a1a] text-white font-medium py-3 rounded-xl hover:bg-[#252525] transition-colors border border-[#2a2a2a]"
                >
                  {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                  <span>{copied ? 'Copied!' : 'Copy Code'}</span>
                </button>
              </div>

              <div className="flex items-center justify-center space-x-2 text-xs text-gray-500">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span>Connected - Share code to invite others</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
