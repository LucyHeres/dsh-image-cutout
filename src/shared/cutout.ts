/** Shared contract between the host tool and the browser Toolview card. */

export interface CutoutItem {
  name: string
  input: string
  output: string
  width: number
  height: number
  /** Share of pixels the model kept, 0..1. */
  foreground: number
  /** Small preview data URLs; empty when the batch is too large to preview. */
  before: string
  after: string
}

export interface CutoutMeta {
  kind: 'image-cutout'
  text: string
  model: string
  items: CutoutItem[]
  hiddenCount: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isItem = (value: unknown): value is CutoutItem => isRecord(value)
  && typeof value['name'] === 'string'
  && typeof value['input'] === 'string'
  && typeof value['output'] === 'string'
  && typeof value['width'] === 'number'
  && typeof value['height'] === 'number'
  && typeof value['foreground'] === 'number'
  && typeof value['before'] === 'string'
  && typeof value['after'] === 'string'

/** Tolerant reader: a partial or foreign meta never throws inside the Toolview. */
export function cutoutMetaFrom(meta: unknown): CutoutMeta | undefined {
  if (!isRecord(meta) || meta['kind'] !== 'image-cutout') return undefined
  const items = Array.isArray(meta['items']) ? meta['items'].filter(isItem) : []
  if (!items.length) return undefined
  return {
    kind: 'image-cutout',
    text: typeof meta['text'] === 'string' ? meta['text'] : '',
    model: typeof meta['model'] === 'string' ? meta['model'] : '',
    items,
    hiddenCount: typeof meta['hiddenCount'] === 'number' ? meta['hiddenCount'] : 0,
  }
}

export const previewLimit = 6

export const cutoutBackgrounds = ['transparent', 'red', 'blue', 'black', 'white'] as const
export type CutoutBackground = typeof cutoutBackgrounds[number]
export const backgroundLabels: Record<CutoutBackground, string> = {
  transparent: '透明', red: '红', blue: '蓝', black: '黑', white: '白',
}
export const backgroundColors: Record<Exclude<CutoutBackground, 'transparent'>, string> = {
  red: '#ff0000', blue: '#0000ff', black: '#000000', white: '#ffffff',
}

export interface CutoutDownloadResult {
  canceled: boolean
  directory?: string
  items: Array<{ id: string; name: string; ok: boolean; output?: string; error?: string }>
}

export interface CutoutLargePreview {
  after: string
  width: number
  height: number
}

export interface CutoutPageResult {
  input: string
  name: string
  id?: string
  ok: boolean
  error?: string
  width?: number
  height?: number
  ms?: number
  after?: string
}

/** Original-image thumbnail for the page's selection strip. */
export interface CutoutPreview {
  path: string
  name: string
  ok: boolean
  error?: string
  before?: string
}
