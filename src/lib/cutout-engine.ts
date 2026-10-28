import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import ort, { type InferenceSession } from 'onnxruntime-node'
import sharp from 'sharp'
import { models, type ModelId, type ModelSpec } from './models.js'

export const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tif', '.tiff', '.bmp', '.gif'])

export interface CutoutResult {
  width: number
  height: number
  /** Share of kept pixels, 0..1. */
  foreground: number
  ms: number
  before: string
  after: string
}

const sessions = new Map<string, Promise<InferenceSession>>()

function sessionFor(path: string) {
  const cached = sessions.get(path)
  if (cached) return cached
  const created = ort.InferenceSession.create(path, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Math.min(4, availableParallelism())),
  })
  sessions.set(path, created)
  void created.catch(() => sessions.delete(path))
  return created
}

/** Release cached sessions and their native memory when the plugin unloads. */
export async function disposeSessions() {
  const pending = [...sessions.values()]
  sessions.clear()
  await Promise.allSettled(pending.map(async entry => {
    const session = await entry
    await session.release?.()
  }))
}

/** Min-max normalization is what rembg applies before resizing the mask back. */
function maskFromOutput(logits: Float32Array, size: number) {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (let i = 0; i < logits.length; i++) {
    const value = logits[i]!
    if (value < low) low = value
    if (value > high) high = value
  }
  const span = high - low || 1
  const mask = Buffer.alloc(size * size)
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(((logits[i]! - low) / span) * 255)
  return mask
}

async function inferMask(rgb: Buffer, width: number, height: number, spec: ModelSpec, path: string) {
  const plane = spec.size * spec.size
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i++) {
    const source = i * 3
    tensor[i] = (rgb[source]! / 255 - spec.mean[0]) / spec.std[0]
    tensor[plane + i] = (rgb[source + 1]! / 255 - spec.mean[1]) / spec.std[1]
    tensor[plane * 2 + i] = (rgb[source + 2]! / 255 - spec.mean[2]) / spec.std[2]
  }
  const session = await sessionFor(path)
  const inputName = session.inputNames[0]
  if (!inputName) throw new Error('抠图模型没有输入张量')
  const output = await session.run({ [inputName]: new ort.Tensor('float32', tensor, [1, 3, spec.size, spec.size]) })
  const result = output[session.outputNames[0]!]
  if (!result) throw new Error('抠图模型没有输出张量')
  const logits = result.data as Float32Array
  if (logits.length !== plane) throw new Error(`抠图模型输出尺寸异常：${logits.length} != ${plane}`)
  return sharp(maskFromOutput(logits, spec.size), { raw: { width: spec.size, height: spec.size, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .extractChannel(0)
    .raw()
    .toBuffer()
}

async function preview(source: Buffer, width: number, height: number) {
  const before = await sharp(source, { raw: { width, height, channels: 3 } })
    .resize(192, 192, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer()
  return `data:image/jpeg;base64,${before.toString('base64')}`
}

async function previewAlpha(source: Buffer, width: number, height: number) {
  const after = await sharp(source, { raw: { width, height, channels: 4 } })
    .resize(192, 192, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, alphaQuality: 88 })
    .toBuffer()
  return `data:image/webp;base64,${after.toString('base64')}`
}

/**
 * Removes the background of one image and writes a transparent PNG.
 * The image is decoded, resized to the model resolution, inferred, and the
 * resulting alpha is resized back to the original pixel grid.
 */
export async function cutoutImage(input: string, output: string, model: ModelId, path: string, signal?: AbortSignal): Promise<CutoutResult> {
  const started = Date.now()
  const spec = models[model]
  signal?.throwIfAborted()
  const source = await readFile(input)
  const { data: rgb, info } = await sharp(source)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width < 2 || info.height < 2) throw new Error(`图片尺寸过小：${input}`)
  if (info.width * info.height > 60_000_000) throw new Error(`图片过大：${info.width}×${info.height}，请先缩小到 6000 万像素以内再处理`)

  const { data: modelRgb } = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize(spec.size, spec.size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  signal?.throwIfAborted()

  const alpha = await inferMask(modelRgb, info.width, info.height, spec, path)
  signal?.throwIfAborted()

  const rgba = Buffer.alloc(info.width * info.height * 4)
  let kept = 0
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4] = rgb[i * 3]!
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!
    const value = alpha[i]!
    rgba[i * 4 + 3] = value
    if (value > 127) kept++
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(output)

  const [before, after] = await Promise.all([
    preview(rgb, info.width, info.height),
    previewAlpha(rgba, info.width, info.height),
  ])
  return {
    width: info.width,
    height: info.height,
    foreground: kept / (info.width * info.height),
    ms: Date.now() - started,
    before,
    after,
  }
}
