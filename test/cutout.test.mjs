import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { cutoutImage } from '../dist/lib/cutout-engine.js'
import { cutoutTool } from '../dist/lib/cutout-tool.js'
import { cutoutMetaFrom } from '../dist/shared/cutout.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = join(root, 'test/fixtures/portrait.jpg')
const model = join(root, 'models/u2netp.onnx')
const signal = new AbortController().signal

async function withTemp(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cutout-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('cutoutImage writes a transparent PNG with the original pixel grid', () => withTemp(async directory => {
  const output = join(directory, 'out.png')
  const result = await cutoutImage(fixture, output, 'fast', model)
  assert.equal(result.width, 480)
  assert.equal(result.height, 640)
  const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.channels, 4)
  assert.equal(info.width, 480)
  assert.equal(info.height, 640)
  const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3]
  assert.ok(alphaAt(1, 1) < 40, `corner alpha ${alphaAt(1, 1)} should be transparent`)
  assert.ok(alphaAt(info.width >> 1, Math.round(info.height * 0.28)) > 200, 'subject should stay opaque')
  assert.ok(result.foreground > 0.05 && result.foreground < 0.9, `foreground ${result.foreground}`)
  assert.match(result.before, /^data:image\/jpeg;base64,/)
  assert.match(result.after, /^data:image\/webp;base64,/)
  assert.ok((await stat(output)).size > 10_000)
}))

test('batch mode writes every image into the output directory', () => withTemp(async directory => {
  const input = join(directory, 'photos')
  await mkdir(input)
  await copyFile(fixture, join(input, 'a.jpg'))
  await copyFile(fixture, join(input, 'b.jpg'))
  const tool = cutoutTool({ defaultModel: 'fast', maxBatch: 10 })
  const value = await tool.execute({ input }, { signal })
  assert.equal(value.items.length, 2)
  assert.match(value.text, /抠图 2 张/)
  const meta = cutoutMetaFrom(value)
  assert.equal(meta?.items.length, 2)
  assert.deepEqual(meta.items.map(item => item.output).sort(), [join(`${input}-cutout`, 'a-cutout.png'), join(`${input}-cutout`, 'b-cutout.png')].sort())
  for (const item of value.items) assert.ok((await stat(item.output)).size > 10_000)
}))

test('existing output is a hard error unless overwrite is requested', () => withTemp(async directory => {
  const input = join(directory, 'one.jpg')
  await copyFile(fixture, input)
  const tool = cutoutTool({ defaultModel: 'fast', maxBatch: 10 })
  await tool.execute({ input, output: directory }, { signal })
  await assert.rejects(tool.execute({ input, output: directory }, { signal }), /输出文件已存在/)
  const value = await tool.execute({ input, output: directory, overwrite: true }, { signal })
  assert.equal(value.items.length, 1)
}))

test('unsupported input and missing paths fail before inference', () => withTemp(async directory => {
  const tool = cutoutTool({ defaultModel: 'fast', maxBatch: 10 })
  await assert.rejects(tool.execute({ input: join(directory, 'nope.png') }, { signal }), /不存在/)
  const text = join(directory, 'note.txt')
  await copyFile(fixture, text)
  await assert.rejects(tool.execute({ input: text }, { signal }), /不支持/)
}))

test('quality model reports a clear install hint when absent', () => withTemp(async directory => {
  const input = join(directory, 'one.jpg')
  await copyFile(fixture, input)
  const tool = cutoutTool({ defaultModel: 'fast', maxBatch: 10 })
  const exists = await stat(join(root, 'models/isnet-general-use.onnx')).then(() => true, () => false)
  if (exists) return
  await assert.rejects(tool.execute({ input, model: 'quality' }, { signal }), /抠图模型缺失/)
}))
