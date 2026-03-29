import { Check, Copy, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import type { VlmAnalysisResult } from '../lib/simpleVlm'

interface VlmAnalysisModalProps {
  isOpen: boolean
  isLoading: boolean
  result: VlmAnalysisResult | null
  error: string
  onClose: () => void
}

export const VlmAnalysisModal = ({
  isOpen,
  isLoading,
  result,
  error,
  onClose
}: VlmAnalysisModalProps) => {
  const [copied, setCopied] = useState(false)

  if (!isOpen) return null

  const copyCode = async () => {
    if (!result?.generatedCode) return
    await navigator.clipboard.writeText(result.generatedCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-[#2a2a2a] flex items-center justify-between">
          <div>
            <h3 className="text-white font-semibold">VLM UI-to-Code</h3>
            <p className="text-xs text-gray-400">Analyze sketch and generate starter code</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-auto">
          {isLoading && (
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-cyan-100 text-sm flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" />
              Initializing simple VLM model and analyzing whiteboard primitives...
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-red-200 text-sm">
              {error}
            </div>
          )}

          {result && !isLoading && !error && (
            <>
              <div className="rounded-lg border border-[#2a2a2a] bg-[#121212] p-4 space-y-2">
                <p className="text-xs uppercase tracking-wider text-gray-500">Model</p>
                <p className="text-sm text-white">{result.modelName}</p>
                <p className="text-sm text-gray-300">{result.summary}</p>
                <p className="text-xs text-cyan-300">
                  Confidence: {(result.confidence * 100).toFixed(0)}%
                </p>
                <p className="text-xs text-gray-400">Detected: {result.detectedElements.join(' | ')}</p>
              </div>

              <div className="rounded-lg border border-[#2a2a2a] bg-[#121212] overflow-hidden">
                <div className="px-4 py-2 border-b border-[#2a2a2a] flex items-center justify-between">
                  <p className="text-xs text-gray-400 uppercase tracking-wider">Generated React Code</p>
                  <button
                    onClick={copyCode}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-[#2f2f2f] text-gray-200 hover:bg-white/5"
                  >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="text-xs text-gray-200 p-4 overflow-auto leading-relaxed">
                  <code>{result.generatedCode}</code>
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
