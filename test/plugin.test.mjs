import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import sharp from 'sharp'
import { apply, name } from '../dist/index.js'
import { CutoutRpc } from '../dist/lib/cutout-rpc.js'
import { CutoutPageSession } from '../dist/lib/cutout-page.js'

function rpcFixture(t, options = {}) {
  const ctx = new Context()
  const service = new CutoutRpc(ctx, { modelDirectory: '', defaultModel: 'fast', maxBatch: 2, ...options })
  t.after(() => ctx.fiber.dispose())
  return { ctx, service, rpc: ctx.get('imageCutout') }
}

test('page RPC exposes only the six session-based methods in the specified order', async t => {
  const { service, rpc } = rpcFixture(t)
  assert.equal(rpc.typertRemote.namespace, 'imageCutout')
  const methods = ['pickImages', 'preview', 'cutout', 'largePreview', 'download', 'release']
  assert.deepEqual(remoteMethods(service).map(marker => marker.method), methods)
  assert.deepEqual(remoteMethods(rpc).map(marker => marker.method), methods)
  assert.equal(rpc.background, undefined)
  assert.equal(rpc.reveal, undefined)
})

test('all RPC requests use strict schemas for UUIDs, paths, model, selections and backgrounds', async t => {
  const { rpc } = rpcFixture(t)
  const sessionId = randomUUID()
  const id = randomUUID()
  const valid = {
    pickImages: {},
    preview: { paths: ['/photos/photo.jpg'] },
    cutout: { sessionId, paths: ['/photos/photo.jpg'] },
    largePreview: { sessionId, id },
    download: { sessionId, ids: [id], background: 'transparent' },
    release: { sessionId },
  }
  for (const [method, request] of Object.entries(valid)) {
    for (const invalid of [undefined, null, [], { ...request, unexpected: true }]) {
      await assert.rejects(rpc[method](invalid), { name: 'ZodError' }, `${method} rejects ${JSON.stringify(invalid)}`)
    }
    if ('sessionId' in request) {
      for (const value of [undefined, '', 'not-a-uuid', '/tmp/session', 12, null]) {
        await assert.rejects(rpc[method]({ ...request, sessionId: value }), { name: 'ZodError' })
      }
    }
  }
  for (const method of ['preview', 'cutout']) {
    for (const paths of [undefined, [], ['a', 'b', 'c'], [''], ['x'.repeat(4001)], [1], 'photo.jpg', null]) {
      await assert.rejects(rpc[method]({ ...valid[method], paths }), { name: 'ZodError' })
    }
  }
  for (const model of ['FAST', 'other', 1, null]) {
    await assert.rejects(rpc.cutout({ ...valid.cutout, model }), { name: 'ZodError' })
  }
  await assert.rejects(rpc.cutout({ ...valid.cutout, background: 'red' }), { name: 'ZodError' })
  await assert.rejects(rpc.cutout({ ...valid.cutout, output: '/tmp/out.png' }), { name: 'ZodError' })
  for (const value of [undefined, '', 'not-a-uuid', '/tmp/cache.png', 1, null]) {
    await assert.rejects(rpc.largePreview({ sessionId, id: value }), { name: 'ZodError' })
  }
  for (const ids of [undefined, [], [id, id], [id, randomUUID(), randomUUID()], ['not-a-uuid'], ['/tmp/cache.png'], [1], id, null]) {
    await assert.rejects(rpc.download({ ...valid.download, ids }), { name: 'ZodError' })
  }
  for (const background of [undefined, 'green', 'RED', '#ff0000', '', null, 1, ['red'], {}]) {
    await assert.rejects(rpc.download({ ...valid.download, background }), { name: 'ZodError' })
  }
  for (const ids of [[id, id], ['not-a-uuid'], [1], id, null]) {
    await assert.rejects(rpc.release({ sessionId, ids }), { name: 'ZodError' })
  }
  for (const method of ['largePreview', 'download', 'release']) {
    await assert.rejects(rpc[method]({ ...valid[method], input: '/tmp/user.png' }), { name: 'ZodError' })
  }
})

test('unknown sessions reject preview/download without opening a dialog; unknown releases are idempotent', async t => {
  const { rpc } = rpcFixture(t)
  const sessionId = randomUUID()
  const id = randomUUID()
  await assert.rejects(rpc.largePreview({ sessionId, id }), /会话不存在或已关闭/)
  for (const background of ['transparent', 'red', 'blue', 'black', 'white']) {
    await assert.rejects(rpc.download({ sessionId, ids: [id], background }), /会话不存在或已关闭/)
  }
  await rpc.release({ sessionId })
  await rpc.release({ sessionId, ids: [] })
  await rpc.release({ sessionId, ids: [id] })
})

test('cutout lazily reuses each page session and forwards models, IDs and request signals', async t => {
  const { rpc, ctx } = rpcFixture(t, { defaultModel: 'quality', modelDirectory: '/local/models' })
  const calls = []
  const result = [{ input: '/photos/photo.jpg', name: 'photo.jpg', id: randomUUID(), ok: true }]
  t.mock.method(CutoutPageSession.prototype, 'cutout', async function (...args) {
    calls.push({ session: this, args })
    return result
  })
  const firstId = randomUUID()
  const secondId = randomUUID()
  const signal = new AbortController().signal
  assert.deepEqual(await rpc.cutout({ sessionId: firstId, paths: ['/photos/photo.jpg'] }, signal), result)
  await rpc.cutout({ sessionId: firstId, paths: ['/photos/second.jpg'], model: 'fast' })
  await rpc.cutout({ sessionId: secondId, paths: ['/photos/third.jpg'], model: 'quality' })
  assert.equal(calls[0].session, calls[1].session)
  assert.notEqual(calls[0].session, calls[2].session)
  assert.deepEqual(calls[0].args, [['/photos/photo.jpg'], 'quality', signal])
  assert.deepEqual(calls[1].args, [['/photos/second.jpg'], 'fast', undefined])
  assert.deepEqual(calls[0].session.options, { modelDirectory: '/local/models' })
  assert.equal(calls[0].session.directory, undefined)
  const preview = { after: 'data:image/png;base64,AAAA', width: 3, height: 2 }
  const large = t.mock.method(CutoutPageSession.prototype, 'largePreview', async function (...args) {
    assert.equal(this, calls[0].session)
    assert.deepEqual(args, [result[0].id, signal])
    return preview
  })
  assert.deepEqual(await rpc.largePreview({ sessionId: firstId, id: result[0].id }, signal), preview)
  assert.equal(large.mock.callCount(), 1)
  const download = t.mock.method(CutoutPageSession.prototype, 'download', async function (...args) {
    assert.equal(this, calls[0].session)
    assert.deepEqual(args, [[result[0].id], 'white', signal])
    return { canceled: true, items: [] }
  })
  assert.deepEqual(await rpc.download({ sessionId: firstId, ids: [result[0].id], background: 'white' }, signal), { canceled: true, items: [] })
  assert.equal(download.mock.callCount(), 1)
  const release = t.mock.method(CutoutPageSession.prototype, 'release', async function (ids) {
    assert.equal(this, calls[0].session)
    assert.deepEqual(ids, [result[0].id])
  })
  await rpc.release({ sessionId: firstId, ids: [result[0].id] })
  assert.equal(release.mock.callCount(), 1)
  await rpc.release({ sessionId: firstId })
  await assert.rejects(rpc.largePreview({ sessionId: firstId, id: result[0].id }), /会话不存在或已关闭/)
  await rpc.release({ sessionId: firstId })
  await ctx.fiber.dispose()
  await assert.rejects(rpc.cutout({ sessionId: randomUUID(), paths: ['/photos/new.jpg'] }), /会话已关闭/)
  assert.equal(calls.length, 3)
})

test('RPC result isolation, selected release and real Cordis lifecycle remove all owned page caches', async t => {
  const { rpc, ctx } = rpcFixture(t)
  const source = await sharp(Buffer.from([80, 120, 160, 0, 80, 120, 160, 128, 80, 120, 160, 255]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer()
  const destination = await mkdtemp(join(tmpdir(), 'cutout-rpc-download-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const owned = []
  t.mock.method(CutoutPageSession.prototype, 'cutout', async function (paths) {
    this.directory ??= mkdtemp(join(tmpdir(), 'dsh-image-cutout-'))
    const directory = await this.directory
    owned.push(directory)
    t.after(() => rm(directory, { recursive: true, force: true }))
    const id = randomUUID()
    const path = join(directory, `${id}.png`)
    await writeFile(path, source)
    this.cached.set(id, { path, name: 'photo.jpg', width: 3, height: 1 })
    return [{ input: paths[0], name: 'photo.jpg', id, ok: true }]
  })
  // Keep the real session download implementation, replacing only its native picker.
  const download = CutoutPageSession.prototype.download
  let dialogs = 0
  t.mock.method(CutoutPageSession.prototype, 'download', function (ids, background, signal) {
    return download.call(this, ids, background, signal, async () => {
      dialogs++
      return { canceled: false, directory: destination }
    })
  })
  const firstPage = randomUUID()
  const secondPage = randomUUID()
  const [first] = await rpc.cutout({ sessionId: firstPage, paths: ['/photos/first.jpg'] })
  const [second] = await rpc.cutout({ sessionId: secondPage, paths: ['/photos/second.jpg'] })
  assert.equal(dialogs, 0)
  const preview = await rpc.largePreview({ sessionId: firstPage, id: first.id })
  assert.equal(preview.width, 3)
  assert.equal(preview.height, 1)
  const alpha = await sharp(Buffer.from(preview.after.split(',')[1], 'base64')).extractChannel('alpha').raw().toBuffer()
  assert.deepEqual([...alpha], [0, 128, 255])
  assert.equal(dialogs, 0)
  await assert.rejects(rpc.largePreview({ sessionId: firstPage, id: second.id }), /不存在或已释放/)
  await assert.rejects(rpc.download({ sessionId: firstPage, ids: [first.id, second.id], background: 'red' }), /不存在或已释放/)
  assert.equal(dialogs, 0)
  const saved = await rpc.download({ sessionId: secondPage, ids: [second.id], background: 'transparent' })
  assert.equal(dialogs, 1)
  assert.equal(saved.items[0].ok, true)
  assert.deepEqual(await readFile(saved.items[0].output), source)
  await rpc.release({ sessionId: firstPage, ids: [first.id] })
  assert.deepEqual(await readdir(owned[0]), [])
  await assert.rejects(rpc.largePreview({ sessionId: firstPage, id: first.id }), /不存在或已释放/)
  assert.ok((await rpc.largePreview({ sessionId: secondPage, id: second.id })).after)
  await ctx.fiber.dispose()
  for (const directory of owned) await assert.rejects(stat(directory), { code: 'ENOENT' })
  assert.deepEqual(await readFile(saved.items[0].output), source)
  await assert.rejects(rpc.largePreview({ sessionId: secondPage, id: second.id }), /会话不存在或已关闭/)
})

test('an aborted RPC cutout does not allocate a session or run inference', async t => {
  const { rpc } = rpcFixture(t)
  const call = t.mock.method(CutoutPageSession.prototype, 'cutout', async () => assert.fail('No inference on abort'))
  const sessionId = randomUUID()
  await assert.rejects(rpc.cutout({ sessionId, paths: ['/photos/photo.jpg'] }, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(call.mock.callCount(), 0)
  await assert.rejects(rpc.largePreview({ sessionId, id: randomUUID() }), /会话不存在或已关闭/)
})

test('apply registers the tool, the skill, the system prompt and both cleanup lifecycles', async () => {
  const captured = { disposers: [] }
  const ctx = {
    tools: { register: definition => { captured.tool = definition; return () => {} } },
    skills: { register: skill => { captured.skill = skill } },
    systemPrompt: { section: section => { captured.prompt = section } },
    effect: effect => { const dispose = effect(); captured.disposers.push(dispose); return dispose },
    reflect: { provide: name => { captured.rpcService = name } },
  }
  apply(ctx, { modelDirectory: '', defaultModel: 'fast', maxBatch: 50 })

  assert.equal(name, 'dsh-image-cutout')
  assert.equal(captured.tool.name, 'remove_background')
  assert.deepEqual(captured.tool.parameters.required, ['input'])
  assert.equal(captured.tool.parameters.properties.input.type, 'string')
  assert.deepEqual(captured.tool.parameters.properties.model.enum, ['fast', 'quality'])
  assert.equal(captured.skill.name, 'image-cutout')
  assert.match(captured.skill.content, /透明背景 PNG/)
  assert.match(captured.prompt.text, /remove_background/)
  assert.match(captured.prompt.text, /不得改用任何在线抠图/)
  assert.equal(captured.prompt.order, 3240)
  assert.equal(captured.rpcService, 'imageCutout')
  assert.equal(captured.disposers.length, 2)
  assert.ok(captured.disposers.every(dispose => typeof dispose === 'function'))
  for (const dispose of [...captured.disposers].reverse()) await dispose()
})
