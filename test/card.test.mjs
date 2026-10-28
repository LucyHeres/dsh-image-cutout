import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

/** Evaluate the browser entry as CJS so the card can render without a browser. */
async function loadClient() {
  const result = await build({
    entryPoints: ['src/client/index.tsx'], bundle: true, write: false, format: 'cjs',
    platform: 'node', external: ['react', 'react/*'], jsx: 'automatic', loader: { '.css': 'text' },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  return { exports: module.exports, text: result.outputFiles[0].text }
}

const meta = {
  kind: 'image-cutout',
  text: '已抠图 2 张',
  model: 'fast',
  hiddenCount: 1,
  items: [
    { name: 'a.jpg', input: '/in/a.jpg', output: '/out/a-cutout.png', width: 480, height: 640, foreground: 0.24, before: 'data:image/jpeg;base64,AA==', after: 'data:image/webp;base64,AA==' },
    { name: 'b.jpg', input: '/in/b.jpg', output: '/out/b-cutout.png', width: 480, height: 640, foreground: 0.31, before: 'data:image/jpeg;base64,AA==', after: 'data:image/webp;base64,AA==' },
  ],
}

test('result card renders previews, sizes and output paths', async () => {
  const { exports: { CutoutCard } } = await loadClient()
  const html = renderToStaticMarkup(createElement(CutoutCard, { phase: 'result', block: { isError: false, meta, content: [] } }))
  assert.match(html, /已抠图 2 张/)
  assert.match(html, /data:image\/webp;base64,AA==/)
  assert.match(html, /480×640/)
  assert.match(html, /\/out\/a-cutout\.png/)
  assert.match(html, /另有 1 张/)
})

test('pending card renders local-only hint', async () => {
  const { exports: { CutoutCard } } = await loadClient()
  const html = renderToStaticMarkup(createElement(CutoutCard, { phase: 'start', block: { args: {} } }))
  assert.match(html, /正在本地抠图/)
  assert.match(html, /不会离开本机/)
})

test('error result falls back to the tool message', async () => {
  const { exports: { CutoutCard } } = await loadClient()
  const html = renderToStaticMarkup(createElement(CutoutCard, {
    phase: 'result',
    block: { isError: true, meta: undefined, content: [{ type: 'text', text: '输出文件已存在' }] },
  }))
  assert.match(html, /抠图失败/)
  assert.match(html, /输出文件已存在/)
})

test('missing meta degrades to a plain completion card', async () => {
  const { exports: { CutoutCard } } = await loadClient()
  const html = renderToStaticMarkup(createElement(CutoutCard, { phase: 'result', block: { isError: false, meta: undefined, content: [] } }))
  assert.match(html, /抠图完成/)
})

test('standalone page renders the selection strip and models', async () => {
  const { exports: { CutoutPage } } = await loadClient()
  const html = renderToStaticMarkup(createElement(CutoutPage, { rpc: async () => [] }))
  assert.match(html, /图片背景移除器/)
  assert.match(html, /一键移除图片背景/)
  assert.match(html, /选择图片/)
  assert.match(html, /开始抠图/)
  assert.match(html, /点击下载后再选择保存目录/)
  assert.doesNotMatch(html, /原图旁|切换即保存|看原图|看结果|复制路径|在访达中显示/)
  assert.match(html, /cpt-source/)
  assert.match(html, /cpt-root/)
  assert.doesNotMatch(html, /图片路径|粘贴图片路径/)
  assert.doesNotMatch(html, /\d+(\.\d+)?\s?MB/)
})

test('client bundle registers sidebar entry and main view', async () => {
  const { text } = await loadClient()
  assert.match(text, /sidebar\.panellist/)
  assert.match(text, /"image-cutout"/)
  assert.match(text, /imageCutout\//)
  assert.match(text, /\.cpt-btn \{/)
  assert.match(text, /\.cpt-btn-lg \{/)
  assert.match(text, /\.cpt-root \{[^}]*overflow-y: auto/)
  assert.match(text, /cpt-background/)
  assert.match(text, /cpt-colors/)
  assert.match(text, /cpt-color-option/)
  assert.match(text, /cpt-download/)
  assert.match(text, /cpt-lightbox/)
  assert.match(text, /aria-modal/)
  assert.doesNotMatch(text, /cpt-compare|cpt-out-btn|cpt-shot-before/)
  assert.match(text, /"transparent", "red", "blue", "black", "white"/)
})

test('RPC 404 explains a full restart while other errors are preserved', async () => {
  const { exports: { cutoutErrorMessage } } = await loadClient()
  assert.match(cutoutErrorMessage(new Error('transport failure for /api/imageCutout/pickImages: HTTP 404')), /完全退出薪灵/)
  assert.equal(cutoutErrorMessage(new Error('输出文件已存在')), '输出文件已存在')
  assert.equal(cutoutErrorMessage('transport failure for /api/other/endpoint: HTTP 404'), 'transport failure for /api/other/endpoint: HTTP 404')
})
