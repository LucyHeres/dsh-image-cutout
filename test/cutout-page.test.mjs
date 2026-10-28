import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CutoutPageSession, pickDirectoryWithDialog, pickImagesWithDialog, previewImages, renderCutoutBackground } from '../dist/lib/cutout-page.js'
import { defaultModelDirectory } from '../dist/lib/models.js'
import { backgroundColors, cutoutBackgrounds } from '../dist/shared/cutout.js'

const fixture = fileURLToPath(new URL('./fixtures/portrait.jpg', import.meta.url))
const solidColors = { red: [255, 0, 0], blue: [0, 0, 255], black: [0, 0, 0], white: [255, 255, 255] }
const backgrounds = ['transparent', ...Object.keys(solidColors)]
const pixels = Buffer.from([
  231, 59, 117, 0,
  60, 130, 200, 128,
  12, 91, 170, 255,
  100, 30, 220, 64,
  33, 180, 80, 192,
  45, 210, 75, 255,
])
const decode = dataUrl => Buffer.from(dataUrl.split(',')[1], 'base64')
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function createSession(t) {
  const session = new CutoutPageSession({ modelDirectory: defaultModelDirectory() })
  t.after(() => session.dispose())
  return session
}

/** Seed only session-owned storage to test rendering/export without repeatedly running inference. */
async function cachedFixture(t, { names = ['portrait.test.jpg', 'second.png'], source, width = 3, height = 2 } = {}) {
  source ??= await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
  const originals = await temporary(t, 'cutout-originals-')
  const destination = await temporary(t, 'cutout-download-')
  const cache = await temporary(t, 'dsh-image-cutout-')
  const session = createSession(t)
  session.directory = Promise.resolve(cache)
  const ids = []
  for (const name of names) {
    const id = randomUUID()
    const path = join(cache, `${id}.png`)
    await writeFile(path, source)
    await writeFile(join(originals, name), source)
    session.cached.set(id, { path, name, width, height })
    ids.push(id)
  }
  return { session, ids, originals, destination, cache, source, names }
}

async function assertPixels(bytes, background) {
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 3)
  assert.equal(metadata.height, 2)
  const actual = await sharp(bytes).ensureAlpha().raw().toBuffer()
  if (background === 'transparent') {
    assert.equal(metadata.hasAlpha, true)
    assert.deepEqual(actual, pixels)
  } else {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3] / 255
      assert.equal(actual[offset + 3], 255)
      for (let channel = 0; channel < 3; channel++) {
        const expected = Math.round(pixels[offset + channel] * alpha + solidColors[background][channel] * (1 - alpha))
        const tolerance = alpha === 0 || alpha === 1 ? 0 : 1
        assert.ok(Math.abs(actual[offset + channel] - expected) <= tolerance,
          `${background} pixel ${offset / 4} channel ${channel}: ${actual[offset + channel]} != ${expected}`)
      }
    }
  }
}

async function assertSourcesUnchanged(sample) {
  for (const name of sample.names) assert.deepEqual(await readFile(join(sample.originals, name)), sample.source)
  assert.deepEqual((await readdir(sample.originals)).sort(), [...new Set(sample.names)].sort())
  for (const id of sample.ids) assert.deepEqual(await readFile(join(sample.cache, `${id}.png`)), sample.source)
  assert.deepEqual((await readdir(sample.cache)).sort(), sample.ids.map(id => `${id}.png`).sort())
}

test('native image picker uses JXA and preserves paths without Electron', { skip: process.platform !== 'darwin' }, async () => {
  const signal = new AbortController().signal
  const selection = { canceled: false, paths: ['/photos/人像 "a".jpg', '/photos/second.jpg'] }
  const result = await pickImagesWithDialog(signal, async (file, args, options) => {
    assert.equal(file, '/usr/bin/osascript')
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e'])
    assert.match(args[3], /multipleSelectionsAllowed: true/)
    assert.match(args[3], /errorNumber !== -128/)
    assert.equal(options.signal, signal)
    return { stdout: JSON.stringify(selection) }
  })
  assert.deepEqual(result, selection)
  assert.deepEqual(await pickImagesWithDialog(undefined, async () => ({ stdout: '{"canceled":true,"paths":[]}' })), { canceled: true, paths: [] })
})

test('download directory picker uses Downloads and handles cancellation without opening a real dialog', { skip: process.platform !== 'darwin' }, async () => {
  const signal = new AbortController().signal
  const selection = { canceled: false, directory: '/photos/人像 "a" $(touch unwanted)' }
  const result = await pickDirectoryWithDialog(signal, async (file, args, options) => {
    assert.equal(file, '/usr/bin/osascript')
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e'])
    assert.match(args[3], /chooseFolder/)
    assert.match(args[3], /withPrompt: '选择图片下载目录'/)
    assert.match(args[3], /defaultLocation: app.pathTo\('downloads folder'\)/)
    assert.match(args[3], /errorNumber !== -128/)
    assert.equal(options.signal, signal)
    return { stdout: JSON.stringify(selection) }
  })
  assert.deepEqual(result, selection)
  assert.deepEqual(await pickDirectoryWithDialog(undefined, async () => ({ stdout: '{"canceled":true}' })), { canceled: true })
  await assert.rejects(pickDirectoryWithDialog(undefined, async () => { throw new Error('dialog failure') }), /dialog failure/)
})

test('aborted native pickers never invoke the executor', async () => {
  for (const picker of [pickImagesWithDialog, pickDirectoryWithDialog]) {
    await assert.rejects(picker(AbortSignal.abort(), async () => assert.fail('No dialog on abort')), { name: 'AbortError' })
  }
})

test('selection previews return original thumbnails and per-file failures', async () => {
  const [good, bad] = await previewImages([fixture, join(dirname(fixture), 'missing.jpg')])
  assert.equal(good.ok, true)
  assert.equal(good.name, 'portrait.jpg')
  assert.match(good.before, /^data:image\/jpeg;base64,/)
  const meta = await sharp(decode(good.before)).metadata()
  assert.equal(meta.width, 192)
  assert.equal(meta.height, 256)
  assert.equal(bad.ok, false)
  assert.ok(bad.error)
  await assert.rejects(previewImages([fixture], AbortSignal.abort()), { name: 'AbortError' })
})

test('real inference returns an opaque cached result and lossless alpha thumbnail without touching the source directory', async t => {
  const directory = await temporary(t, 'cutout-page-input-')
  const input = join(directory, 'portrait.jpg')
  const sibling = join(directory, 'portrait-cutout.png')
  const corrupt = join(directory, 'corrupt.jpg')
  await copyFile(fixture, input)
  await writeFile(sibling, 'existing user output')
  await writeFile(corrupt, 'not an image')
  const before = await readFile(input)
  const filesBefore = (await readdir(directory)).sort()
  const session = createSession(t)
  assert.equal(session.directory, undefined)
  const results = await session.cutout([join(directory, 'missing.jpg'), input, corrupt], 'fast')
  assert.equal(results.length, 3)
  const [missing, result, invalid] = results
  for (const failure of [missing, invalid]) {
    assert.equal(failure.ok, false)
    assert.ok(failure.error)
    assert.deepEqual(Object.keys(failure).sort(), ['error', 'input', 'name', 'ok'])
  }
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(Object.keys(result).sort(), ['after', 'height', 'id', 'input', 'ms', 'name', 'ok', 'width'])
  assert.equal(result.input, input)
  assert.equal(result.name, 'portrait.jpg')
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(result.ms >= 0)
  const cache = await session.directory
  assert.equal(dirname(cache), tmpdir().replace(/\/$/, ''))
  assert.match(basename(cache), /^dsh-image-cutout-/)
  assert.notEqual(cache, directory)
  assert.deepEqual(await readdir(cache), [`${result.id}.png`])
  const bytes = await readFile(join(cache, `${result.id}.png`))
  const meta = await sharp(bytes).metadata()
  assert.equal(meta.format, 'png')
  assert.equal(meta.hasAlpha, true)
  assert.equal(result.width, meta.width)
  assert.equal(result.height, meta.height)
  assert.ok((await sharp(bytes).stats()).channels[3].min < 255)
  const thumbnail = decode(result.after)
  assert.match(result.after, /^data:image\/webp;base64,/)
  const thumbMeta = await sharp(thumbnail).metadata()
  assert.equal(Math.max(thumbMeta.width, thumbMeta.height), 384)
  assert.equal(thumbMeta.hasAlpha, true)
  const expected = await sharp(bytes).resize(384, 384, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer()
  const actual = await sharp(thumbnail).ensureAlpha().raw().toBuffer()
  for (let offset = 0; offset < expected.length; offset += 4) {
    assert.equal(actual[offset + 3], expected[offset + 3])
    if (expected[offset + 3]) assert.deepEqual(actual.subarray(offset, offset + 3), expected.subarray(offset, offset + 3))
  }
  assert.deepEqual((await readdir(directory)).sort(), filesBefore)
  assert.deepEqual(await readFile(input), before)
  assert.equal(await readFile(sibling, 'utf8'), 'existing user output')
  await session.release([result.id])
  assert.deepEqual(await readdir(cache), [])
  await session.dispose()
  await assert.rejects(stat(cache), { code: 'ENOENT' })
})

test('background choices expose transparency and exactly four pure RGB solids', () => {
  assert.deepEqual(cutoutBackgrounds, backgrounds)
  assert.deepEqual(backgroundColors, { red: '#ff0000', blue: '#0000ff', black: '#000000', white: '#ffffff' })
})

for (const background of backgrounds) {
  test(`pure ${background} rendering preserves partially transparent pixels and never mutates input bytes`, async () => {
    const source = await sharp(pixels, { raw: { width: 3, height: 2, channels: 4 } }).png().toBuffer()
    const before = Buffer.from(source)
    const rendered = await renderCutoutBackground(source, background)
    await assertPixels(rendered, background)
    assert.deepEqual(source, before)
    if (background === 'transparent') assert.equal(rendered, source)
  })

  test(`explicit download writes two ${background} results only to the chosen directory`, async t => {
    const sample = await cachedFixture(t)
    assert.deepEqual(await readdir(sample.destination), [])
    let pickCount = 0
    const result = await sample.session.download(sample.ids, background, undefined, async signal => {
      assert.equal(signal.aborted, false)
      pickCount++
      return { canceled: false, directory: sample.destination }
    })
    assert.equal(pickCount, 1)
    assert.equal(result.canceled, false)
    assert.equal(result.directory, sample.destination)
    assert.equal(result.items.length, 2)
    for (const [index, item] of result.items.entries()) {
      assert.equal(item.id, sample.ids[index])
      assert.equal(item.name, sample.names[index])
      assert.equal(item.ok, true, item.error)
      const bytes = await readFile(item.output)
      await assertPixels(bytes, background)
      if (background === 'transparent') assert.deepEqual(bytes, sample.source)
    }
    assert.deepEqual((await readdir(sample.destination)).sort(), ['portrait.test-cutout.png', 'second-cutout.png'])
    await assertSourcesUnchanged(sample)
  })
}

test('large previews preserve alpha and original dimensions without creating files or enlarging small images', async t => {
  for (const [width, height] of [[3, 2], [3200, 1600], [1000, 3000]]) {
    await t.test(`${width}x${height}`, async t => {
      const source = await sharp({ create: { width, height, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 0.5 } } }).png().toBuffer()
      const sample = await cachedFixture(t, { source, width, height })
      const before = await stat(join(sample.cache, `${sample.ids[0]}.png`), { bigint: true })
      const result = await sample.session.largePreview(sample.ids[0])
      assert.deepEqual(Object.keys(result).sort(), ['after', 'height', 'width'])
      assert.equal(result.width, width)
      assert.equal(result.height, height)
      assert.match(result.after, /^data:image\/png;base64,/)
      const preview = decode(result.after)
      const meta = await sharp(preview).metadata()
      assert.equal(meta.format, 'png')
      assert.equal(meta.hasAlpha, true)
      assert.equal(Math.max(meta.width, meta.height), Math.min(2048, Math.max(width, height)))
      assert.ok(meta.width <= width && meta.height <= height)
      const alpha = await sharp(preview).extractChannel('alpha').raw().toBuffer()
      assert.ok(alpha.every(value => value === 128), `alpha preview must stay semi-transparent (${width}x${height})`)
      assert.equal((await stat(join(sample.cache, `${sample.ids[0]}.png`), { bigint: true })).mtimeNs, before.mtimeNs)
      assert.deepEqual(await readdir(sample.destination), [])
      await assertSourcesUnchanged(sample)
    })
  }
})

test('canceling the download picker creates no outputs and preserves cached results', async t => {
  const sample = await cachedFixture(t)
  const result = await sample.session.download(sample.ids, 'white', undefined, async () => ({ canceled: true }))
  assert.deepEqual(result, { canceled: true, items: [] })
  assert.deepEqual(await readdir(sample.destination), [])
  await assertSourcesUnchanged(sample)
})

test('same-name downloads and existing files receive numeric suffixes and are never overwritten', async t => {
  const sample = await cachedFixture(t, { names: ['portrait.test.jpg', 'portrait.test.jpg'] })
  const existing = join(sample.destination, 'portrait.test-cutout.png')
  const second = join(sample.destination, 'portrait.test-cutout-2.png')
  await writeFile(existing, 'existing user file')
  await writeFile(second, sample.source)
  const before = await stat(second, { bigint: true })
  const result = await sample.session.download(sample.ids, 'red', undefined, async () => ({ canceled: false, directory: sample.destination }))
  assert.deepEqual(result.items.map(item => basename(item.output)), ['portrait.test-cutout-3.png', 'portrait.test-cutout-4.png'])
  assert.equal(await readFile(existing, 'utf8'), 'existing user file')
  assert.deepEqual(await readFile(second), sample.source)
  assert.equal((await stat(second, { bigint: true })).mtimeNs, before.mtimeNs)
  const repeated = await sample.session.download([sample.ids[0]], 'transparent', undefined, async () => ({ canceled: false, directory: sample.destination }))
  assert.equal(basename(repeated.items[0].output), 'portrait.test-cutout-5.png')
  await assertSourcesUnchanged(sample)
})

test('existing and dangling output symlinks cannot overwrite source images or other files', { skip: process.platform === 'win32' }, async t => {
  const sample = await cachedFixture(t)
  const original = join(sample.originals, sample.names[0])
  await symlink(original, join(sample.destination, 'portrait.test-cutout.png'))
  await symlink(join(sample.originals, 'nonexistent.png'), join(sample.destination, 'portrait.test-cutout-2.png'))
  const result = await sample.session.download([sample.ids[0]], 'blue', undefined, async () => ({ canceled: false, directory: sample.destination }))
  assert.equal(result.items[0].ok, true)
  assert.equal(basename(result.items[0].output), 'portrait.test-cutout-3.png')
  await assert.rejects(stat(join(sample.originals, 'nonexistent.png')), { code: 'ENOENT' })
  await assertSourcesUnchanged(sample)
})

test('save failures are per-file and keep successes before and after a failed item', async t => {
  const sample = await cachedFixture(t, { names: ['first.jpg', `${'x'.repeat(248)}.jpg`, 'last.jpg'] })
  const result = await sample.session.download(sample.ids, 'black', undefined, async () => ({ canceled: false, directory: sample.destination }))
  assert.deepEqual(result.items.map(item => item.ok), [true, false, true])
  assert.match(result.items[1].error, /ENAMETOOLONG/)
  assert.equal(result.items[1].output, undefined)
  assert.deepEqual((await readdir(sample.destination)).sort(), ['first-cutout.png', 'last-cutout.png'])
  await assertSourcesUnchanged(sample)
})

test('a missing directory or a selected regular file produces per-file failures without mkdir', async t => {
  const sample = await cachedFixture(t)
  for (const directory of [join(sample.destination, 'missing'), join(sample.originals, sample.names[0])]) {
    const result = await sample.session.download(sample.ids, 'white', undefined, async () => ({ canceled: false, directory }))
    assert.equal(result.canceled, false)
    assert.equal(result.directory, directory)
    assert.deepEqual(result.items.map(item => item.ok), [false, false])
    assert.ok(result.items.every(item => item.error && !item.output))
  }
  assert.deepEqual(await readdir(sample.destination), [])
  await assertSourcesUnchanged(sample)
})

test('all IDs are validated before the picker; release removes only selected owned results', async t => {
  const sample = await cachedFixture(t)
  const other = await cachedFixture(t)
  const picker = async () => assert.fail('Invalid IDs must not open a picker')
  for (const ids of [[sample.ids[0], randomUUID()], [sample.ids[0], other.ids[0]], [], [sample.ids[0], sample.ids[0]]]) {
    await assert.rejects(sample.session.download(ids, 'red', undefined, picker))
  }
  await assert.rejects(sample.session.largePreview(randomUUID()), /不存在或已释放/)
  await sample.session.release([sample.ids[0], randomUUID(), sample.ids[0]])
  await assert.rejects(sample.session.largePreview(sample.ids[0]), /不存在或已释放/)
  await assert.rejects(sample.session.download(sample.ids, 'red', undefined, picker), /不存在或已释放/)
  assert.deepEqual(await readdir(sample.cache), [`${sample.ids[1]}.png`])
  assert.ok((await sample.session.largePreview(sample.ids[1])).after)
  await sample.session.release([])
  await assertSourcesUnchanged(other)
  assert.deepEqual(await readdir(sample.destination), [])
})

test('request cancellation before and after the picker prevents downloads', async t => {
  const sample = await cachedFixture(t)
  const controller = new AbortController()
  const reason = new Error('request canceled')
  controller.abort(reason)
  await assert.rejects(sample.session.download(sample.ids, 'red', controller.signal, async () => assert.fail('No picker')), error => error === reason)
  await assert.rejects(sample.session.largePreview(sample.ids[0], controller.signal), error => error === reason)
  await assert.rejects(sample.session.cutout([fixture], 'fast', controller.signal), error => error === reason)
  const later = new AbortController()
  await assert.rejects(sample.session.download(sample.ids, 'red', later.signal, async () => {
    later.abort(reason)
    return { canceled: false, directory: sample.destination }
  }), error => error === reason)
  assert.deepEqual(await readdir(sample.destination), [])
  await assertSourcesUnchanged(sample)
})

test('releasing a result while a picker is pending guards against a late save', async t => {
  const sample = await cachedFixture(t)
  const result = await sample.session.download([sample.ids[0]], 'white', undefined, async () => {
    await sample.session.release([sample.ids[0]])
    return { canceled: false, directory: sample.destination }
  })
  assert.equal(result.items[0].ok, false)
  assert.match(result.items[0].error, /不存在或已释放/)
  assert.deepEqual(await readdir(sample.destination), [])
})

test('disposal waits for an outstanding picker, rejects late operations and removes only its owned cache', async t => {
  const sample = await cachedFixture(t)
  const other = await cachedFixture(t)
  const entered = deferred()
  const finish = deferred()
  const pending = sample.session.download(sample.ids, 'blue', undefined, async signal => {
    entered.resolve(signal)
    await finish.promise
    return { canceled: false, directory: sample.destination }
  })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  const signal = await entered.promise
  let disposed = false
  const disposal = sample.session.dispose().then(() => { disposed = true })
  assert.equal(signal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.ok((await stat(sample.cache)).isDirectory())
  await assert.rejects(sample.session.largePreview(sample.ids[0]), { name: 'AbortError' })
  finish.resolve()
  await rejected
  await disposal
  await sample.session.dispose()
  await sample.session.release(sample.ids)
  await assert.rejects(stat(sample.cache), { code: 'ENOENT' })
  await assert.rejects(sample.session.cutout([fixture], 'fast'), { name: 'AbortError' })
  assert.deepEqual(await readdir(sample.destination), [])
  for (const name of sample.names) assert.deepEqual(await readFile(join(sample.originals, name)), sample.source)
  await assertSourcesUnchanged(other)
})

test('disposal waits for an in-flight engine file write instead of deleting its directory early', async t => {
  const directory = await temporary(t, 'cutout-pending-input-')
  const input = join(directory, 'portrait.jpg')
  await copyFile(fixture, input)
  const session = createSession(t)
  const entered = deferred()
  const finish = deferred()
  const toFile = sharp.prototype.toFile
  t.mock.method(sharp.prototype, 'toFile', async function (output, ...args) {
    entered.resolve(output)
    await finish.promise
    return toFile.call(this, output, ...args)
  })
  const pending = session.cutout([input], 'fast')
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  const output = await entered.promise
  let disposed = false
  const disposal = session.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.ok((await stat(dirname(output))).isDirectory())
  finish.resolve()
  await rejected
  await disposal
  await assert.rejects(stat(dirname(output)), { code: 'ENOENT' })
  assert.deepEqual(await readdir(directory), ['portrait.jpg'])
  assert.deepEqual(await readFile(input), await readFile(fixture))
})

test('canceling a batch after one success removes undisclosed results and the pending output', async t => {
  const directory = await temporary(t, 'cutout-cancel-input-')
  const input = join(directory, 'portrait.jpg')
  await copyFile(fixture, input)
  const session = createSession(t)
  const controller = new AbortController()
  const toFile = sharp.prototype.toFile
  let writes = 0
  t.mock.method(sharp.prototype, 'toFile', async function (output, ...args) {
    const result = await toFile.call(this, output, ...args)
    if (++writes === 2) controller.abort()
    return result
  })
  await assert.rejects(session.cutout([input, input], 'fast', controller.signal), { name: 'AbortError' })
  assert.equal(writes, 2)
  assert.equal(session.cached.size, 0)
  assert.deepEqual(await readdir(await session.directory), [])
  assert.deepEqual(await readdir(directory), ['portrait.jpg'])
})

test('unused and already canceled sessions allocate no temporary directory', async t => {
  const session = createSession(t)
  await assert.rejects(session.cutout([fixture], 'fast', AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(session.directory, undefined)
  await session.dispose()
  assert.equal(session.directory, undefined)
})
