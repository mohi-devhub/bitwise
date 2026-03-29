export interface CanvasDrawingPrimitive {
  id?: string
  tool: string
  x0: number
  y0: number
  x1?: number
  y1?: number
  text?: string
  color?: string
}

export interface VlmAnalysisRequest {
  imageDataUrl: string
  roomId: string
  drawings?: CanvasDrawingPrimitive[]
}

export interface VlmAnalysisResult {
  modelName: string
  summary: string
  confidence: number
  detectedElements: string[]
  generatedCode: string
}

interface SimpleVlmModel {
  name: string
  version: string
  initializedAt: number
}

let modelInstance: SimpleVlmModel | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const initializeSimpleVlm = async (): Promise<SimpleVlmModel> => {
  if (modelInstance) return modelInstance

  // Simulate lightweight model warmup in renderer process.
  await sleep(250)

  modelInstance = {
    name: 'Bitwise-SimpleVLM',
    version: '0.2.0',
    initializedAt: Date.now()
  }

  return modelInstance
}

const sortByLayout = (a: CanvasDrawingPrimitive, b: CanvasDrawingPrimitive) => {
  if (Math.abs(a.y0 - b.y0) > 24) return a.y0 - b.y0
  return a.x0 - b.x0
}

const getBounds = (d: CanvasDrawingPrimitive) => {
  const minX = Math.min(d.x0, d.x1 ?? d.x0)
  const maxX = Math.max(d.x0, d.x1 ?? d.x0)
  const minY = Math.min(d.y0, d.y1 ?? d.y0)
  const maxY = Math.max(d.y0, d.y1 ?? d.y0)
  return { minX, maxX, minY, maxY }
}

const isInside = (x: number, y: number, box: { minX: number; maxX: number; minY: number; maxY: number }) =>
  x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY

const pointToBoxDistance = (
  x: number,
  y: number,
  box: { minX: number; maxX: number; minY: number; maxY: number }
) => {
  const dx = Math.max(box.minX - x, 0, x - box.maxX)
  const dy = Math.max(box.minY - y, 0, y - box.maxY)
  return Math.sqrt(dx * dx + dy * dy)
}

const cleanLabel = (value: string) => value.replace(/\s+/g, ' ').trim()

const toPascalCase = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('') || 'GeneratedFromCanvas'

const clampConfidence = (value: number) => Math.max(0.45, Math.min(0.92, value))

const createActionCardCode = (componentName: string, title: string, description: string, actionLabel: string) => `import React from 'react'

export default function ${componentName}() {
  return (
    <main className="min-h-screen bg-[#0d0d0d] text-white p-8 flex items-center justify-center">
      <section className="w-full max-w-md border border-[#2a2a2a] rounded-2xl bg-[#121212] p-8 shadow-2xl text-center">
        <h1 className="text-2xl font-bold tracking-tight">${title}</h1>
        <p className="text-gray-400 mt-3">${description}</p>

        <button className="mt-8 w-full px-5 py-3 rounded-lg bg-white text-black font-semibold hover:bg-gray-200 transition-colors">
          ${actionLabel}
        </button>
      </section>
    </main>
  )
}
`

const createGeneralLayoutCode = (
  componentName: string,
  title: string,
  description: string,
  hasInputHint: boolean,
  hasStatusDots: boolean,
  buttonLabels: string[]
) => {
  const uniqueLabels = buttonLabels.filter((label, index, arr) => arr.indexOf(label) === index)
  const fallbackButtons = uniqueLabels.length === 0 ? ['Primary Action'] : uniqueLabels

  const buttonsMarkup = fallbackButtons
    .map((label, index) => {
      if (index === 0) {
        return `<button className="px-5 py-2.5 rounded-lg bg-white text-black font-semibold">${label}</button>`
      }
      return `<button className="px-5 py-2.5 rounded-lg border border-[#3a3a3a] text-white">${label}</button>`
    })
    .join('\n          ')

  const inputMarkup = hasInputHint
    ? '<input className="mt-6 w-full rounded-lg border border-[#333] bg-[#0f0f0f] px-4 py-3" placeholder="Type here" />'
    : ''

  const statusMarkup = hasStatusDots
    ? '<div className="mt-6 text-xs text-green-400">Status indicators detected from sketch</div>'
    : ''

  return `import React from 'react'

export default function ${componentName}() {
  return (
    <main className="min-h-screen bg-[#0d0d0d] text-white p-8 flex items-center justify-center">
      <section className="w-full max-w-2xl border border-[#2a2a2a] rounded-2xl bg-[#121212] p-8 shadow-2xl">
        <h1 className="text-3xl font-bold tracking-tight">${title}</h1>
        <p className="text-gray-400 mt-3">${description}</p>

        ${inputMarkup}

        <div className="mt-8 flex gap-3 flex-wrap">
          ${buttonsMarkup}
        </div>

        ${statusMarkup}
      </section>
    </main>
  )
}
`
}

export const analyzeCanvasToCode = async (request: VlmAnalysisRequest): Promise<VlmAnalysisResult> => {
  const model = await initializeSimpleVlm()
  const drawings = request.drawings ?? []

  const textNodes = drawings
    .filter((d) => d.tool === 'Type' && d.text && d.text.trim())
    .map((d) => ({ ...d, text: cleanLabel(d.text || '') }))
    .sort(sortByLayout)

  const squareNodes = drawings.filter((d) => d.tool === 'Square')
  const lineNodes = drawings.filter((d) => d.tool === 'Minus')
  const circleNodes = drawings.filter((d) => d.tool === 'Circle')

  const buttonCandidates = squareNodes
    .map((square) => {
      const bounds = getBounds(square)
      const insideLabel = textNodes.find((textNode) => isInside(textNode.x0, textNode.y0, bounds))?.text

      const nearestText = textNodes
        .map((textNode) => ({
          label: textNode.text,
          distance: pointToBoxDistance(textNode.x0, textNode.y0, bounds)
        }))
        .sort((a, b) => a.distance - b.distance)[0]

      const proximityThreshold = 42
      const label =
        insideLabel ||
        (nearestText && nearestText.distance <= proximityThreshold ? nearestText.label : undefined)

      const width = Math.abs((square.x1 ?? square.x0) - square.x0)
      const height = Math.abs((square.y1 ?? square.y0) - square.y0)
      const isButtonShape = width >= 60 && width <= 340 && height >= 24 && height <= 90
      return {
        label,
        isButtonShape
      }
    })
    .filter((candidate) => candidate.isButtonShape && candidate.label)

  const buttonLabels = buttonCandidates.map((candidate) => candidate.label || '').filter(Boolean)
  const buttonLabelSet = new Set(buttonLabels)
  const nonButtonTexts = textNodes
    .map((node) => node.text || '')
    .filter((label) => label && !buttonLabelSet.has(label))

  const inferredTitle = nonButtonTexts[0] || textNodes[0]?.text || 'Sketch Generated UI'
  const supportingLines = nonButtonTexts.slice(1)
  const description = supportingLines.slice(0, 2).join(' ') || 'Converted from whiteboard drawing.'

  const hasInputHint = lineNodes.length > 0
  const hasStatusDots = circleNodes.length >= 3

  const minimalSingleActionFallback =
    squareNodes.length === 1 && textNodes.length === 1 && lineNodes.length === 0 && circleNodes.length === 0

  const singleActionPatternDetected =
    squareNodes.length === 1 &&
    (buttonLabels.length === 1 || minimalSingleActionFallback) &&
    textNodes.length <= 2 &&
    lineNodes.length === 0 &&
    circleNodes.length === 0

  const templateName = singleActionPatternDetected ? 'single-action-card' : 'general-layout'
  const componentName = singleActionPatternDetected
    ? `${toPascalCase(buttonLabels[0] || textNodes[0]?.text || 'Action')}ActionCard`
    : `${toPascalCase(inferredTitle)}Screen`

  const code = singleActionPatternDetected
    ? createActionCardCode(
        componentName,
        nonButtonTexts[0] || `${buttonLabels[0] || textNodes[0]?.text || 'Primary'} Action`,
        nonButtonTexts[1] || 'Action inferred from whiteboard sketch.',
        buttonLabels[0] || textNodes[0]?.text || 'Continue'
      )
    : createGeneralLayoutCode(
        componentName,
        inferredTitle,
        description,
        hasInputHint,
        hasStatusDots,
        buttonLabels
      )

  const detectedElements = [
    `${textNodes.length} text element(s)`,
    `${squareNodes.length} rectangular shape(s)`,
    `${lineNodes.length} line stroke(s)`,
    `${circleNodes.length} circular shape(s)`
  ]

  const confidenceBase =
    0.5 + Math.min(textNodes.length, 4) * 0.07 + Math.min(squareNodes.length, 3) * 0.05
  const confidence = clampConfidence(confidenceBase + (singleActionPatternDetected ? 0.12 : 0))

  return {
    modelName: `${model.name}@${model.version}`,
    summary: `Analyzed ${drawings.length} canvas primitive(s), matched ${templateName}, and generated React + Tailwind starter code.`,
    confidence,
    detectedElements,
    generatedCode: code
  }
}
