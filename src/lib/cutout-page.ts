import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { cutoutImage } from './cutout-engine.js'
import { assertModel, type ModelId } from './models.js'
import { backgroundColors, type CutoutBackground, type CutoutDownloadResult, type CutoutLargePreview, type CutoutPageResult, type CutoutPreview } from '../shared/cutout.js'

const executeFile = promisify(execFile)
const pickerScript = `
const app = Application.currentApplication();
app.includeStandardAdditions = true;
try {
  const files = app.chooseFile({ withPrompt: '选择要抠图的图片', ofType: ['public.image'], multipleSelectionsAllowed: true });
  JSON.stringify({ canceled: false, paths: files.map(file => file.toString()) });
} catch (error) {
  if (error.errorNumber !== -128) throw error;
  JSON.stringify({ canceled: true, paths: [] });
}`
const directoryPickerScript = `
const app = Application.currentApplication();
app.includeStandardAdditions = true;
try {
  const directory = app.chooseFolder({ withPrompt: '选择图片下载目录', defaultLocation: app.pathTo('downloads folder') });
  JSON.stringify({ canceled: false, directory: directory.toString() });
} catch (error) {
  if (error.errorNumber !== -128) throw error;
  JSON.stringify({ canceled: true });
}`

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Background selection is a render operation, never an implicit save. */
export async function renderCutoutBackground(source: Buffer, background: CutoutBackground): Promise<Buffer> {
  return background === 'transparent'
    ? source
    : sharp(source).flatten({ background: backgroundColors[background] }).png().toBuffer()
}

/** Small original-image previews so the page can show the selection before inference. */
export async function previewImages(paths: string[], signal?: AbortSignal): Promise<CutoutPreview[]> {
  const results: CutoutPreview[] = []
  for (const input of paths) {
    signal?.throwIfAborted()
    const name = basename(input)
    try {
      const source = await readFile(input)
      const { data } = await sharp(source)
        .rotate()
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 74 })
        .toBuffer({ resolveWithObject: true })
      signal?.throwIfAborted()
      results.push({ path: input, name, ok: true, before: `data:image/jpeg;base64,${data.toString('base64')}` })
    } catch (error) {
      signal?.throwIfAborted()
      results.push({ path: input, name, ok: false, error: errorMessage(error) })
    }
  }
  return results
}

// DSH runs plugins outside Electron's main process, so native dialogs use JXA.
export async function pickImagesWithDialog(signal?: AbortSignal, run = executeFile): Promise<{ canceled: boolean; paths: string[] }> {
  signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('原生选图目前仅支持 macOS；请在 macOS 客户端中选择图片')
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', pickerScript], { encoding: 'utf8', signal })
  signal?.throwIfAborted()
  return JSON.parse(stdout.toString())
}

export async function pickDirectoryWithDialog(signal?: AbortSignal, run = executeFile): Promise<{ canceled: boolean; directory?: string }> {
  signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('原生目录选择目前仅支持 macOS；请在 macOS 客户端中下载图片')
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', directoryPickerScript], { encoding: 'utf8', signal })
  signal?.throwIfAborted()
  return JSON.parse(stdout.toString())
}

interface CachedCutout {
  path: string
  name: string
  width: number
  height: number
}

/** Exclusive creation also rejects existing symlinks; no existing file is opened for writing. */
async function saveDownload(directory: string, name: string, bytes: Buffer, signal: AbortSignal) {
  const stem = `${basename(name, extname(name))}-cutout`
  for (let version = 1; ; version++) {
    signal.throwIfAborted()
    const output = join(directory, `${stem}${version === 1 ? '' : `-${version}`}.png`)
    let file
    try {
      file = await open(output, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      signal.throwIfAborted()
      await file.writeFile(bytes, { signal })
      signal.throwIfAborted()
      await file.close()
      return output
    } catch (error) {
      await file.close()
      // This path was exclusively created by this operation, not a pre-existing user file.
      await rm(output, { force: true })
      throw error
    }
  }
}

/** A page owns only its temporary transparent results; downloads require an explicit picker. */
export class CutoutPageSession {
  private readonly cached = new Map<string, CachedCutout>()
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private directory?: Promise<string>
  private disposal?: Promise<void>

  constructor(private readonly options: { modelDirectory: string }) {}

  private operation<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    const task = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return work(combined)
    })
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  private getCached(id: string) {
    const entry = this.cached.get(id)
    if (!entry) throw new Error(`抠图结果不存在或已释放：${id}`)
    return entry
  }

  cutout(paths: string[], model: ModelId, signal?: AbortSignal): Promise<CutoutPageResult[]> {
    return this.operation(signal, async combined => {
      const modelFile = assertModel(model, this.options.modelDirectory)
      const results: CutoutPageResult[] = []
      const completed = new Map<string, CachedCutout>()
      try {
        for (const input of paths) {
          combined.throwIfAborted()
          const name = basename(input)
          this.directory ??= mkdtemp(join(tmpdir(), 'dsh-image-cutout-'))
          const directory = await this.directory
          combined.throwIfAborted()
          const id = randomUUID()
          const output = join(directory, `${id}.png`)
          try {
            const result = await cutoutImage(input, output, model, modelFile, combined)
            combined.throwIfAborted()
            const source = await readFile(output)
            const thumbnail = await sharp(source)
              .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
              .webp({ lossless: true })
              .toBuffer()
            combined.throwIfAborted()
            completed.set(id, { path: output, name, width: result.width, height: result.height })
            results.push({ input, name, id, ok: true, width: result.width, height: result.height, ms: result.ms, after: `data:image/webp;base64,${thumbnail.toString('base64')}` })
          } catch (error) {
            await rm(output, { force: true })
            combined.throwIfAborted()
            results.push({ input, name, ok: false, error: errorMessage(error) })
          }
        }
        combined.throwIfAborted()
        for (const [id, entry] of completed) this.cached.set(id, entry)
        return results
      } catch (error) {
        // A canceled batch cannot deliver its IDs, so do not retain its completed results.
        await Promise.all([...completed.values()].map(entry => rm(entry.path, { force: true })))
        throw error
      }
    })
  }

  largePreview(id: string, signal?: AbortSignal): Promise<CutoutLargePreview> {
    return this.operation(signal, async combined => {
      const entry = this.getCached(id)
      const source = await readFile(entry.path)
      combined.throwIfAborted()
      const preview = await sharp(source)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
      combined.throwIfAborted()
      this.getCached(id)
      return { after: `data:image/png;base64,${preview.toString('base64')}`, width: entry.width, height: entry.height }
    })
  }

  download(ids: string[], background: CutoutBackground, signal?: AbortSignal, pickDirectory = pickDirectoryWithDialog): Promise<CutoutDownloadResult> {
    return this.operation(signal, async combined => {
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error('请选择不重复的抠图结果')
      // Validate the whole selection before opening a dialog or writing any file.
      const entries = ids.map(id => ({ id, entry: this.getCached(id) }))
      const selection = await pickDirectory(combined)
      combined.throwIfAborted()
      if (selection.canceled) return { canceled: true, items: [] }
      const directory = selection.directory
      try {
        if (!directory || !isAbsolute(directory) || !(await stat(directory)).isDirectory()) {
          throw new Error('请选择已存在的图片下载目录')
        }
      } catch (error) {
        combined.throwIfAborted()
        return { canceled: false, directory, items: entries.map(({ id, entry }) => ({ id, name: entry.name, ok: false, error: errorMessage(error) })) }
      }
      combined.throwIfAborted()
      const items: CutoutDownloadResult['items'] = []
      for (const { id, entry } of entries) {
        combined.throwIfAborted()
        try {
          this.getCached(id)
          const source = await readFile(entry.path)
          combined.throwIfAborted()
          const rendered = await renderCutoutBackground(source, background)
          combined.throwIfAborted()
          this.getCached(id)
          const output = await saveDownload(directory, entry.name, rendered, combined)
          items.push({ id, name: entry.name, ok: true, output })
        } catch (error) {
          combined.throwIfAborted()
          items.push({ id, name: entry.name, ok: false, error: errorMessage(error) })
        }
      }
      return { canceled: false, directory, items }
    })
  }

  release(ids: string[]): Promise<void> {
    if (this.controller.signal.aborted) return this.disposal ?? Promise.resolve()
    return this.operation(undefined, async () => {
      const paths: string[] = []
      for (const id of ids) {
        const entry = this.cached.get(id)
        if (!entry) continue
        this.cached.delete(id)
        paths.push(entry.path)
      }
      await Promise.all(paths.map(path => rm(path, { force: true })))
    })
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.controller.abort(new DOMException('抠图页面会话已关闭', 'AbortError'))
    this.disposal = (async () => {
      // The engine may be finishing a native write; wait before removing our owned folder.
      await Promise.allSettled([...this.pending])
      this.cached.clear()
      const directory = await this.directory?.catch(() => undefined)
      if (directory) await rm(directory, { recursive: true, force: true })
    })()
    return this.disposal
  }
}
