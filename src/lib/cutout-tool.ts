import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { cutoutImage, supportedExtensions } from './cutout-engine.js'
import { assertModel, type ModelId } from './models.js'
import type { CutoutItem } from '../shared/cutout.js'
import { previewLimit } from '../shared/cutout.js'

export interface CutoutToolOptions {
  modelDirectory?: string
  defaultModel: ModelId
  maxBatch: number
}

const withoutExtension = (path: string) => {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

const isImage = (path: string) => supportedExtensions.has(extname(path).toLowerCase())

const outputName = (input: string) => `${basename(withoutExtension(input))}-cutout.png`

async function listImages(directory: string, limit: number) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && isImage(entry.name))
    .map(entry => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  if (!files.length) throw new Error(`目录中没有支持的图片：${directory}`)
  if (files.length > limit) throw new Error(`一次最多处理 ${limit} 张，当前目录有 ${files.length} 张；请分批处理或指定更具体的目录。`)
  return files
}

/** Resolve the requested output before any inference so failures happen up front. */
async function planOutputs(inputs: string[], sourceDirectory: string | undefined, requested: string | undefined) {
  const explicit = requested?.trim() ? resolve(requested) : ''
  const planned: { input: string; output: string }[] = []
  if (!sourceDirectory) {
    const input = inputs[0]!
    if (!explicit) {
      planned.push({ input, output: join(dirname(input), outputName(input)) })
    } else {
      const info = await stat(explicit).catch(() => undefined)
      if (info?.isDirectory() || /[\\/]$/.test(requested!)) planned.push({ input, output: join(explicit, outputName(input)) })
      else if (extname(explicit).toLowerCase() === '.png') planned.push({ input, output: explicit })
      else if (isImage(explicit)) throw new Error('输出必须是 .png 文件或目录')
      else planned.push({ input, output: join(explicit, outputName(input)) })
    }
  } else {
    const target = explicit || `${sourceDirectory.replace(/[\\/]+$/, '')}-cutout`
    for (const input of inputs) planned.push({ input, output: join(target, outputName(input)) })
  }
  const unique = new Set(planned.map(plan => plan.output))
  if (unique.size !== planned.length) throw new Error('多个输入会写到同一个输出文件，请改用目录输出。')
  return planned
}

export function cutoutTool(options: CutoutToolOptions) {
  return defineTool({
    name: 'remove_background',
    description: '把图片主体抠出来并输出透明背景 PNG：支持单张图片或整个目录批量处理。用户要求抠图、去背景、做透明底 PNG 时使用。完全在本机推理，图片不会上传；支持 PNG/JPEG/WebP/TIFF/BMP/AVIF。',
    parameters: {
      input: { type: 'string', required: true, description: '图片文件路径，或包含图片的目录；可用绝对路径或相对当前工作目录的路径' },
      output: { type: 'string', description: '输出位置：单图可给 .png 文件路径或目录；批量时必须给目录；省略时写到原图同目录的 <原名>-cutout.png，批量省略时写到同级 <目录名>-cutout/ 目录' },
      model: { type: 'string', enum: ['fast', 'quality'], description: 'fast 使用 u2netp（约 4MB，速度快，适合大多数照片）；quality 使用 ISNet（约 176MB，发丝和复杂边缘更稳，速度慢数倍）' },
      overwrite: { type: 'boolean', description: '输出文件已存在时是否覆盖，默认 false：存在则报错且不处理任何图片' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: typeof (value as { text?: unknown }).text === 'string' ? (value as { text: string }).text : '抠图完成' }],
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600_000,
    async execute(args, exec) {
      const input = resolve(args.input)
      const info = await stat(input).catch(() => undefined)
      if (!info) throw new Error(`输入路径不存在：${input}`)
      const batch = info.isDirectory()
      if (!batch && !isImage(input)) throw new Error(`不支持的图片格式：${extname(input) || '无扩展名'}；支持 ${[...supportedExtensions].join(' ')}`)
      const inputs = batch ? await listImages(input, options.maxBatch) : [input]
      const plans = await planOutputs(inputs, batch ? input : undefined, args.output)
      const model = (args.model ?? options.defaultModel) as ModelId
      const modelFile = assertModel(model, options.modelDirectory)

      if (!args.overwrite) {
        const exists = await Promise.all(plans.map(plan => stat(plan.output).then(() => plan.output, () => '')))
        const conflicts = exists.filter(Boolean)
        if (conflicts.length) throw new Error(`输出文件已存在（共 ${conflicts.length} 个）：${conflicts.slice(0, 3).join('、')}${conflicts.length > 3 ? ' 等' : ''}。确认覆盖请传 overwrite=true。`)
      }

      const started = Date.now()
      const items: CutoutItem[] = []
      for (const plan of plans) {
        exec.signal.throwIfAborted()
        await mkdir(dirname(plan.output), { recursive: true })
        const result = await cutoutImage(plan.input, plan.output, model, modelFile, exec.signal)
        items.push({
          name: basename(plan.input),
          input: plan.input,
          output: plan.output,
          width: result.width,
          height: result.height,
          foreground: result.foreground,
          before: items.length < previewLimit ? result.before : '',
          after: items.length < previewLimit ? result.after : '',
        })
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      const shown = items.slice(0, 5).map(item => item.output).join('、')
      const text = `已用 ${model === 'fast' ? '快速' : '高质量'}模型抠图 ${items.length} 张（${seconds} 秒）：${shown}${items.length > 5 ? ` 等 ${items.length} 个文件` : ''}`
      return { kind: 'image-cutout', text, model, items, hiddenCount: Math.max(0, items.length - previewLimit) } as unknown as JsonValue
    },
  })
}
