import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  ChatBubbleIcon, CheckCircledIcon, CheckIcon, ClockIcon, Cross2Icon, DownloadIcon,
  ExclamationTriangleIcon, ImageIcon, LightningBoltIcon, ZoomInIcon,
  MagicWandIcon, PlayIcon, PlusIcon, ReloadIcon, ScissorsIcon, StopIcon,
} from '@radix-ui/react-icons'
import { backgroundColors, backgroundLabels, cutoutBackgrounds, cutoutMetaFrom, type CutoutBackground, type CutoutDownloadResult, type CutoutLargePreview, type CutoutPageResult, type CutoutPreview } from '../shared/cutout.js'
import styles from './style.css'

export const name = 'dsh-image-cutout'
export const inject = ['slots', 'connection', 'layout']

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>

const cardStyles = `
.dic-card { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 13px; line-height: 1.5;
  --dic-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dic-ok-ink: color-mix(in srgb, var(--dic-ok) 62%, var(--dsw-alias-label-primary, #0f1115));
  --dic-err: var(--dsw-alias-state-error-primary, #ec1313);
  --dic-muted: var(--dsw-alias-label-secondary, #61666b);
  --dic-soft: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 6%, transparent); }
.dic-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dic-icon { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 8px; }
.dic-icon svg { width: 15px; height: 15px; }
.dic-icon-ok { color: var(--dic-ok-ink); background: color-mix(in srgb, var(--dic-ok) 14%, transparent); }
.dic-icon-error { color: var(--dic-err); background: color-mix(in srgb, var(--dic-err) 10%, transparent); }
.dic-title { font-weight: 600; }
.dic-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; }
.dic-tag { padding: 1px 7px; border-radius: 999px; background: var(--dic-soft); color: var(--dic-muted); font-size: 10.5px; white-space: nowrap; }
.dic-muted { color: var(--dic-muted); font-size: 12px; }
.dic-error-text { margin: 0; color: var(--dic-err); overflow-wrap: anywhere; }
.dic-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; }
.dic-item { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dic-shot { aspect-ratio: 1; border-radius: 10px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background-color: #fff;
  background-image: linear-gradient(45deg, #e9ebef 25%, transparent 25%), linear-gradient(-45deg, #e9ebef 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e9ebef 75%), linear-gradient(-45deg, transparent 75%, #e9ebef 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
body[data-ds-dark-theme] .dic-shot { background-color: #17181b;
  background-image: linear-gradient(45deg, #24252a 25%, transparent 25%), linear-gradient(-45deg, #24252a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #24252a 75%), linear-gradient(-45deg, transparent 75%, #24252a 75%); }
.dic-shot img { width: 100%; height: 100%; object-fit: contain; display: block; }
.dic-caption { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dic-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dic-meta { display: flex; flex-wrap: wrap; gap: 0 8px; color: var(--dic-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dic-paths { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--dic-soft); font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; max-height: 120px; overflow: auto; }
.dic-paths code { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dic-pending { display: flex; align-items: center; gap: 10px; }
.dic-pending-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dic-spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid var(--dic-soft); border-top-color: var(--dsw-alias-state-business-primary, #4176e6); animation: dic-spin .8s linear infinite; }
@keyframes dic-spin { to { transform: rotate(360deg); } }
.dic-bar { height: 3px; border-radius: 999px; overflow: hidden; background: var(--dic-soft); }
.dic-bar span { display: block; width: 38%; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary, #4176e6); animation: dic-sweep 1.3s ease-in-out infinite; }
@keyframes dic-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
@media (prefers-reduced-motion: reduce) { .dic-spinner, .dic-bar span { animation: none; } .dic-bar span { width: 100%; opacity: .5; } }
`

function Shell({ children }: { children: ReactNode }) {
  return <div className="dic-card">
    <style>{cardStyles}</style>
    {children}
  </div>
}

function ResultCard({ block }: { block: Extract<ToolCallViewProps, { phase: 'result' }>['block'] }) {
  if (block.isError) {
    const text = block.content.map(part => part.type === 'text' ? part.text : '').join('').trim()
    return <Shell>
      <div className="dic-head">
        <span className="dic-icon dic-icon-error"><ExclamationTriangleIcon aria-hidden="true" /></span>
        <span className="dic-title">抠图失败</span>
      </div>
      <p className="dic-error-text">{text || '请检查输入路径与输出位置后重试。'}</p>
    </Shell>
  }
  const meta = cutoutMetaFrom(block.meta)
  if (!meta) return <Shell><div className="dic-head"><span className="dic-title">抠图完成</span></div></Shell>
  const previews = meta.items.filter(item => item.after || item.before).slice(0, 6)
  return <Shell>
    <div className="dic-head">
      <span className="dic-icon dic-icon-ok"><CheckCircledIcon aria-hidden="true" /></span>
      <span className="dic-title">已抠图 {meta.items.length} 张</span>
      <span className="dic-tags">
        <span className="dic-tag">{meta.model === 'quality' ? '高清模型' : '快速模型'}</span>
        <span className="dic-tag">本地推理</span>
        <span className="dic-tag">透明 PNG</span>
      </span>
    </div>
    {previews.length > 0 && <div className="dic-grid">{previews.map((item, index) => <figure className="dic-item" key={`${item.output}-${index}`}>
      <div className="dic-shot"><img src={item.after || item.before} alt={`${item.name} 去背景结果`} loading="lazy" decoding="async" /></div>
      <figcaption className="dic-caption">
        <span className="dic-name" title={item.name}>{item.name}</span>
        <span className="dic-meta"><span>{item.width}×{item.height}</span><span>主体 {Math.round(item.foreground * 100)}%</span></span>
      </figcaption>
    </figure>)}</div>}
    <div className="dic-paths" aria-label="输出文件">
      {meta.items.map(item => <code key={item.output} title={item.output}>{item.output}</code>)}
    </div>
    {meta.hiddenCount > 0 && <span className="dic-muted">另有 {meta.hiddenCount} 张已完成，输出路径见上。</span>}
  </Shell>
}

export function CutoutCard(props: ToolCallViewProps) {
  if (props.phase === 'result') return <ResultCard block={props.block} />
  return <Shell>
    <div className="dic-pending">
      <span className="dic-spinner" aria-hidden="true" />
      <span className="dic-pending-text">
        <span className="dic-title">正在本地抠图…</span>
        <span className="dic-muted">图片不会离开本机</span>
      </span>
    </div>
    <div className="dic-bar" aria-hidden="true"><span /></div>
  </Shell>
}

interface QueueItem { path: string; name: string; preview?: string; previewFailed?: boolean }

const seconds = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} 秒`

export function cutoutErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.includes('/api/imageCutout/') && /\bHTTP 404\b/.test(message)
    ? '抠图宿主接口尚未加载。请按 ⌘Q 完全退出薪灵，再重新打开；关闭窗口或刷新页面不会重启宿主。'
    : message
}

function LargePreview({ result, background, rpc, sessionId, onClose }: {
  result: CutoutPageResult
  background: CutoutBackground
  rpc: Rpc
  sessionId: string
  onClose: () => void
}) {
  const [image, setImage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void rpc<CutoutLargePreview>('largePreview', { sessionId, id: result.id }, controller.signal)
      .then(preview => { if (!controller.signal.aborted) setImage(preview.after) })
      .catch(cause => { if (!controller.signal.aborted) setError(cutoutErrorMessage(cause)) })
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', escape)
    return () => { controller.abort(); document.removeEventListener('keydown', escape) }
  }, [rpc, sessionId, result.id, onClose])

  return <div className="cpt-lightbox-layer" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="cpt-lightbox" role="dialog" aria-modal="true" aria-labelledby="cpt-lightbox-title">
      <header className="cpt-lightbox-head">
        <div><h2 id="cpt-lightbox-title">{result.name}</h2><span>{result.width}×{result.height} · {backgroundLabels[background]}背景</span></div>
        <button type="button" className="cpt-btn cpt-btn-sm" onClick={onClose} autoFocus aria-label="关闭大图"><Cross2Icon aria-hidden="true" /></button>
      </header>
      <div className="cpt-lightbox-stage" data-background={background} aria-busy={!image && !error}
        style={background === 'transparent' ? undefined : { backgroundColor: backgroundColors[background] }}>
        {error ? <p className="cpt-card-error" role="alert">{error}</p>
          : image ? <img src={image} alt={`${result.name} ${backgroundLabels[background]}背景大图`} />
            : <span className="cpt-lightbox-loading" role="status">正在加载大图…</span>}
      </div>
    </div>
  </div>
}

export function CutoutPage({ rpc }: PropsRuntime<'main'> & { rpc: Rpc }) {
  const [sessionId] = useState(() => crypto.randomUUID())
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [model, setModel] = useState<'fast' | 'quality'>('fast')
  const [background, setBackground] = useState<CutoutBackground>('transparent')
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadNote, setDownloadNote] = useState('')
  const working = busy || !!retrying || downloading
  const [activePath, setActivePath] = useState('')
  const [error, setError] = useState('')
  const [results, setResults] = useState<CutoutPageResult[]>([])
  const [viewing, setViewing] = useState<CutoutPageResult | null>(null)
  const closePreview = useCallback(() => setViewing(null), [])
  const mounted = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abortRef.current?.abort()
      void rpc('release', { sessionId }).catch(() => {})
    }
  }, [rpc, sessionId])

  const loadPreviews = async (paths: string[]) => {
    try {
      const previews = await rpc<CutoutPreview[]>('preview', { paths })
      if (!mounted.current) return
      const byPath = new Map(previews.map(item => [item.path, item]))
      setQueue(previous => previous.map(item => {
        const preview = byPath.get(item.path)
        if (!preview) return item
        return preview.ok && preview.before
          ? { ...item, preview: preview.before }
          : { ...item, previewFailed: true }
      }))
    } catch (cause) {
      if (!mounted.current) return
      setQueue(previous => previous.map(item => paths.includes(item.path) ? { ...item, previewFailed: true } : item))
      setError(cutoutErrorMessage(cause))
    }
  }

  const addPaths = (paths: string[]) => {
    const cleaned = paths.map(path => path.trim()).filter(Boolean)
    const known = new Set(queue.map(item => item.path))
    const fresh = [...new Set(cleaned)].filter(path => !known.has(path))
    if (!fresh.length) return
    setQueue(previous => [...previous, ...fresh.map(path => ({ path, name: path.split(/[\\/]/).pop() || path }))])
    setError('')
    void loadPreviews(fresh)
  }

  const pick = async () => {
    setError('')
    try {
      const picked = await rpc<{ canceled: boolean; paths: string[] }>('pickImages', {})
      if (!picked.canceled) addPaths(picked.paths)
    } catch (cause) {
      setError(cutoutErrorMessage(cause))
    }
  }

  const run = async () => {
    if (!queue.length || working) return
    const controller = new AbortController()
    abortRef.current = controller
    const collected: CutoutPageResult[] = []
    let failed = 0
    setBusy(true); setError(''); setDownloadNote(''); setResults([]); setViewing(null)
    try {
      const ids = results.flatMap(entry => entry.id ? [entry.id] : [])
      if (ids.length) await rpc('release', { sessionId, ids }, controller.signal)
      for (const item of queue) {
        if (controller.signal.aborted) break
        setActivePath(item.path)
        try {
          const [result] = await rpc<CutoutPageResult[]>('cutout', { sessionId, paths: [item.path], model }, controller.signal)
          if (!mounted.current) return
          const entry: CutoutPageResult = result ?? {
            input: item.path, name: item.name, ok: false, error: '没有返回结果，请重试。',
          }
          if (!entry.ok) failed++
          collected.push(entry)
          setResults([...collected])
        } catch (cause) {
          if (controller.signal.aborted) break
          if (!mounted.current) return
          failed++
          collected.push({ input: item.path, name: item.name, ok: false, error: cutoutErrorMessage(cause) })
          setResults([...collected])
        }
      }
      if (!mounted.current) return
      if (controller.signal.aborted) {
        setError(collected.length
          ? `已停止，完成 ${collected.length} 张，还有 ${queue.length - collected.length} 张没有处理。`
          : '已停止，没有处理任何图片。')
      } else if (failed > 0) {
        setError(`${failed} 张处理失败，可以在结果卡片上单独重试。`)
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cutoutErrorMessage(cause))
    } finally {
      if (mounted.current) { setBusy(false); setActivePath('') }
      abortRef.current = null
    }
  }

  const stop = () => { abortRef.current?.abort() }

  const retry = async (target: CutoutPageResult) => {
    if (working) return
    const controller = new AbortController()
    abortRef.current = controller
    setRetrying(target.input); setError(''); setDownloadNote('')
    try {
      const [next] = await rpc<CutoutPageResult[]>('cutout', { sessionId, paths: [target.input], model }, controller.signal)
      if (!mounted.current || !next) return
      setResults(previous => previous.map(entry => entry.input === target.input ? next : entry))
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cutoutErrorMessage(cause))
    } finally {
      if (mounted.current) setRetrying('')
      abortRef.current = null
    }
  }

  const download = async () => {
    const ids = results.flatMap(entry => entry.ok && entry.id ? [entry.id] : [])
    if (working || !ids.length) return
    const controller = new AbortController()
    abortRef.current = controller
    setDownloading(true); setDownloadNote(''); setError('')
    try {
      const saved = await rpc<CutoutDownloadResult>('download', { sessionId, ids, background }, controller.signal)
      if (!mounted.current) return
      if (saved.canceled) {
        setDownloadNote('已取消下载，未保存图片。')
        return
      }
      const succeeded = saved.items.filter(item => item.ok).length
      const failures = saved.items.filter(item => !item.ok)
      setDownloadNote(succeeded ? `已保存 ${succeeded} 张图片到 ${saved.directory}` : '')
      if (failures.length) setError(`${failures.length} 张下载失败：${failures.map(item => `${item.name}（${item.error}）`).join('；')}`)
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cutoutErrorMessage(cause))
    } finally {
      if (mounted.current) setDownloading(false)
      abortRef.current = null
    }
  }

  const moveModel = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = model === 'fast' ? 'quality' : 'fast'
    setModel(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-model="${next}"]`)
      ?.focus()
  }

  const removeItem = (path: string) => {
    if (working) return
    const id = results.find(entry => entry.input === path)?.id
    if (id) void rpc('release', { sessionId, ids: [id] }).catch(cause => {
      if (mounted.current) setError(cutoutErrorMessage(cause))
    })
    setDownloadNote('')
    setQueue(previous => previous.filter(item => item.path !== path))
    setResults(previous => previous.filter(entry => entry.input !== path))
  }

  const resultOf = (path: string) => results.find(entry => entry.input === path)
  const done = results.length
  const total = queue.length
  const percent = total ? Math.round((done / total) * 100) : 0
  const successes = results.filter(entry => entry.ok).length
  const failures = results.length - successes
  const elapsed = results.reduce((sum, entry) => sum + (entry.ok ? entry.ms ?? 0 : 0), 0)
  const activeName = queue.find(item => item.path === activePath)?.name ?? ''

  return <div className="cpt-root">
    <style>{styles}</style>
    <div className="cpt-page">
    <header className="cpt-head">
      <span className="cpt-mark" aria-hidden="true"><ScissorsIcon /></span>
      <div className="cpt-head-text">
        <h1 className="cpt-title">图片背景移除器</h1>
        <p className="cpt-sub">一键移除图片背景——可批量上传商品图、人像、复杂场景</p>
      </div>
    </header>

    <section className="cpt-source" data-empty={queue.length === 0} aria-label={queue.length ? '已选图片' : '选择图片'}>
      <div className="cpt-strip">
        <button type="button" className="cpt-add-tile" onClick={pick} disabled={working}
          aria-label={queue.length ? '继续添加图片' : '选择图片'}>
          <PlusIcon aria-hidden="true" />
          {queue.length === 0 && <span>选择图片</span>}
        </button>
        {queue.map(item => {
          const entry = resultOf(item.path)
          const state = item.path === activePath ? 'active' : entry?.ok ? 'done' : entry ? 'failed' : ''
          return <figure className="cpt-tile" data-state={state} key={item.path}>
            <span className="cpt-tile-shot">
              {item.preview
                ? <img src={item.preview} alt={`${item.name} 原图`} loading="lazy" decoding="async" />
                : item.previewFailed
                  ? <span className="cpt-tile-fallback"><ImageIcon aria-hidden="true" />无法预览</span>
                  : <span className="cpt-tile-loading" aria-hidden="true" />}
              {state && <span className="cpt-tile-badge" data-tone={state} aria-hidden="true">
                {state === 'done' ? <CheckIcon /> : state === 'failed' ? <Cross2Icon /> : <span className="cpt-tile-dot" />}
              </span>}
              <button type="button" className="cpt-tile-remove" aria-label={`移除 ${item.name}`} disabled={working}
                onClick={() => removeItem(item.path)}><Cross2Icon aria-hidden="true" /></button>
            </span>
            <figcaption className="cpt-tile-name" title={item.path}>{item.name}</figcaption>
          </figure>
        })}
      </div>
      {queue.length === 0 && <p className="cpt-source-hint">支持 PNG、JPEG、WebP、TIFF、BMP、AVIF，GIF 只取第一帧</p>}
    </section>

    <section className="cpt-section" aria-labelledby="cpt-model-title">
      <div className="cpt-section-head">
        <h2 id="cpt-model-title">模型</h2>
        <span className="cpt-section-hint">已随插件安装，无需下载</span>
      </div>
      <div className="cpt-models" role="radiogroup" aria-label="抠图模型">
        <button type="button" role="radio" aria-checked={model === 'fast'} className="cpt-model" data-on={model === 'fast'} data-model="fast"
          tabIndex={model === 'fast' ? 0 : -1} disabled={working} onClick={() => setModel('fast')} onKeyDown={moveModel}>
          {model === 'fast' && <CheckCircledIcon className="cpt-model-check" aria-hidden="true" />}
          <span className="cpt-model-top"><LightningBoltIcon aria-hidden="true" />快速<span className="cpt-tag">推荐</span></span>
          <span className="cpt-model-desc">日常照片与商品图，出图最快</span>
        </button>
        <button type="button" role="radio" aria-checked={model === 'quality'} className="cpt-model" data-on={model === 'quality'} data-model="quality"
          tabIndex={model === 'quality' ? 0 : -1} disabled={working} onClick={() => setModel('quality')} onKeyDown={moveModel}>
          {model === 'quality' && <CheckCircledIcon className="cpt-model-check" aria-hidden="true" />}
          <span className="cpt-model-top"><MagicWandIcon aria-hidden="true" />高清</span>
          <span className="cpt-model-desc">发丝、毛发与复杂边缘更干净</span>
        </button>
      </div>
    </section>

    <div className="cpt-run">
      {busy
        ? <div className="cpt-progress">
          <div className="cpt-progress-head">
            <span className="cpt-progress-label">正在抠图<b>{done}/{total}</b></span>
            <span className="cpt-progress-file" title={activePath}>{activeName || '准备模型…'}</span>
            <button type="button" className="cpt-btn cpt-btn-sm" onClick={stop}><StopIcon aria-hidden="true" />停止</button>
          </div>
          <div className="cpt-progress-track" role="progressbar" aria-label="抠图进度"
            aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
        : <div className="cpt-run-row">
          <button type="button" className="cpt-btn cpt-btn-primary cpt-btn-lg" onClick={run}
            disabled={!queue.length || working}>
            <PlayIcon aria-hidden="true" />开始抠图{queue.length > 0 ? `（${queue.length} 张）` : ''}
          </button>
          <span className="cpt-run-note">先预览效果，点击下载后再选择保存目录</span>
        </div>}
    </div>

    {error && <div className="cpt-alert" role="alert">
      <ExclamationTriangleIcon aria-hidden="true" />
      <span>{error}</span>
    </div>}

    {results.length > 0 && <section className="cpt-section" aria-labelledby="cpt-results-title">
      <div className="cpt-section-head">
        <h2 id="cpt-results-title">结果<span className="cpt-count">{results.length}</span></h2>
        <div className="cpt-summary">
          <span className="cpt-summary-item" data-tone="ok"><CheckIcon aria-hidden="true" />{successes} 完成</span>
          {failures > 0 && <span className="cpt-summary-item" data-tone="error"><Cross2Icon aria-hidden="true" />{failures} 失败</span>}
          {elapsed > 0 && <span className="cpt-summary-item"><ClockIcon aria-hidden="true" />{seconds(elapsed)}</span>}
        </div>
      </div>
      <div className="cpt-result-toolbar">
        <fieldset className="cpt-background" disabled={downloading} aria-label="统一背景颜色">
          <legend>背景颜色<span>应用于全部图片</span></legend>
          <div className="cpt-colors">
            {cutoutBackgrounds.map(color => <label className="cpt-color" key={color}>
              <input type="radio" name={`background-${sessionId}`} value={color} checked={background === color}
                onChange={() => { setBackground(color); setDownloadNote('') }} />
              <span className="cpt-color-option">
                <span className="cpt-swatch" data-transparent={color === 'transparent'} aria-hidden="true"
                  style={color === 'transparent' ? undefined : { backgroundColor: backgroundColors[color] }} />
                <span>{backgroundLabels[color]}</span>
              </span>
            </label>)}
          </div>
        </fieldset>
        <button type="button" className="cpt-btn cpt-btn-primary cpt-btn-lg cpt-download" onClick={download}
          disabled={working || successes === 0}>
          <DownloadIcon aria-hidden="true" />{downloading ? '选择目录并下载中…' : `下载全部（${successes} 张）`}
        </button>
      </div>
      {downloadNote && <p className="cpt-download-note" role="status">{downloadNote}</p>}
      <div className="cpt-grid">
        {results.map((result, index) => <article className="cpt-card" data-ok={result.ok} key={result.input} style={{ animationDelay: `${index * 40}ms` }}>
          <div className="cpt-shot" data-background={background} style={background === 'transparent' ? undefined : { backgroundColor: backgroundColors[background] }}>
            {result.after
              ? <img src={result.after} alt={`${result.name} ${backgroundLabels[background]}背景预览`} loading="lazy" decoding="async" />
              : <span className="cpt-shot-empty"><ImageIcon aria-hidden="true" />没有预览</span>}
            {result.ok && result.id && <button type="button" className="cpt-enlarge" aria-label={`查看大图 ${result.name}`}
              onClick={() => setViewing(result)}><ZoomInIcon aria-hidden="true" />查看大图</button>}
          </div>
          <div className="cpt-card-body">
            <span className="cpt-card-name" title={result.name}>{result.name}</span>
            {!result.ok && <>
              <span className="cpt-card-error">{result.error || '处理失败'}</span>
              <button type="button" className="cpt-btn cpt-btn-sm cpt-retry" disabled={working} onClick={() => retry(result)}>
                <ReloadIcon aria-hidden="true" />{retrying === result.input ? '重试中…' : '重试'}
              </button>
            </>}
          </div>
        </article>)}
      </div>
    </section>}

    <p className="cpt-foot">
      <ChatBubbleIcon aria-hidden="true" />
      也可以直接在对话里说「把这几张图的背景去掉」，结果会出现在聊天里。
    </p>
    {viewing && <LargePreview result={viewing} background={background} sessionId={sessionId} rpc={rpc} onClose={closePreview} />}
    </div>
  </div>
}

export function apply(ctx: Context) {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'remove_background' }, CutoutCard))
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const rpc: Rpc = async (method, request, signal) => {
    const result = await (ctx.get('connection') as ConnectionHandle).rpc.call('/api', `imageCutout/${method}`, { args: request === undefined ? {} : { request } }, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as never
  }
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'image-cutout', label: '图片背景移除器', order: 90 }, ScissorsIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'image-cutout', inject: () => ({ rpc }) }, CutoutPage))
}
