import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { CutoutPageSession, pickImagesWithDialog, previewImages } from './cutout-page.js'
import type { ModelId } from './models.js'
import { cutoutBackgrounds } from '../shared/cutout.js'

declare module '@deepseek-ai/cordis' { interface Context { imageCutout: CutoutRpc } }

const uuid = z.string().uuid()
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length

export class CutoutRpc extends TypertRemoteService {
  private readonly sessions = new Map<string, CutoutPageSession>()
  private disposed = false

  constructor(ctx: Context, private readonly options: { modelDirectory: string; defaultModel: ModelId; maxBatch: number }) {
    super(ctx, 'imageCutout', { namespace: 'imageCutout' })
    ctx.effect(() => async () => {
      this.disposed = true
      const sessions = [...this.sessions.values()]
      this.sessions.clear()
      await Promise.all(sessions.map(session => session.dispose()))
    })
  }

  private getSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (this.disposed || !session) throw new Error('抠图页面会话不存在或已关闭，请重新处理图片')
    return session
  }

  @Remote
  async pickImages(request: unknown, signal?: AbortSignal) {
    z.object({}).strict().parse(request)
    return pickImagesWithDialog(signal)
  }

  @Remote
  async preview(request: unknown, signal?: AbortSignal) {
    const { paths } = z.object({
      paths: z.array(z.string().min(1).max(4000)).min(1).max(this.options.maxBatch),
    }).strict().parse(request)
    return previewImages(paths, signal)
  }

  @Remote
  async cutout(request: unknown, signal?: AbortSignal) {
    const { sessionId, paths, model } = z.object({
      sessionId: uuid,
      paths: z.array(z.string().min(1).max(4000)).min(1).max(this.options.maxBatch),
      model: z.enum(['fast', 'quality']).optional(),
    }).strict().parse(request)
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('抠图页面会话已关闭')
    let session = this.sessions.get(sessionId)
    if (!session) {
      // A reload cannot reliably release its old page session; keep only a bounded set.
      while (this.sessions.size >= 8) {
        const [oldestId, oldest] = this.sessions.entries().next().value!
        this.sessions.delete(oldestId)
        await oldest.dispose()
      }
      session = new CutoutPageSession({ modelDirectory: this.options.modelDirectory })
      this.sessions.set(sessionId, session)
    }
    return session.cutout(paths, model ?? this.options.defaultModel, signal)
  }

  @Remote
  async largePreview(request: unknown, signal?: AbortSignal) {
    const { sessionId, id } = z.object({ sessionId: uuid, id: uuid }).strict().parse(request)
    return this.getSession(sessionId).largePreview(id, signal)
  }

  @Remote
  async download(request: unknown, signal?: AbortSignal) {
    const { sessionId, ids, background } = z.object({
      sessionId: uuid,
      ids: z.array(uuid).min(1).max(this.options.maxBatch).refine(uniqueIds, '抠图结果 ID 不能重复'),
      background: z.enum(cutoutBackgrounds),
    }).strict().parse(request)
    return this.getSession(sessionId).download(ids, background, signal)
  }

  @Remote
  async release(request: unknown) {
    const { sessionId, ids } = z.object({
      sessionId: uuid,
      ids: z.array(uuid).refine(uniqueIds, '抠图结果 ID 不能重复').optional(),
    }).strict().parse(request)
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (ids) {
      await session.release(ids)
    } else {
      await session.dispose()
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    }
  }
}
