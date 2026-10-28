import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const p = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))
const files = new Set(pack.files.map(file => file.path))

for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/client.js', 'dist/client/index.d.ts', 'models/u2netp.onnx', 'models/isnet-general-use.onnx', 'skills/image-cutout/SKILL.md', 'cordis.patch.yml', 'dsh-target.json', 'README.md']) {
  assert.ok(files.has(file), `缺少打包文件 ${file}`)
}
for (const [dep, version] of Object.entries(p.peerDependencies)) assert.equal(p.devDependencies[dep], version)
assert.equal(p.dsh.client.platform, 'web')
assert.equal(p.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(p.exports['.'].default, './' + p.main)
for (const exported of Object.values(p.exports)) {
  const entry = typeof exported === 'string' ? exported : exported.default
  assert.ok(files.has(entry.replace(/^\.\//, '')), `缺少导出文件 ${entry}`)
}
const model = pack.files.find(file => file.path === 'models/u2netp.onnx')
assert.ok(model.size > 4_000_000, 'u2netp 模型不完整')
const quality = pack.files.find(file => file.path === 'models/isnet-general-use.onnx')
assert.ok(quality.size > 160_000_000, 'isnet 高清模型不完整，先运行 npm run fetch:quality-model')

const client = await readFile(resolve(root, p.exports['./client'].default), 'utf8')
assert.ok(client.startsWith('window.__ModuleLoader__.load('), '客户端必须是 DSH lazy-CJS factory 格式')
assert.ok(!/['"]node:/.test(client), '客户端不能打包 Node 内置模块')
assert.ok(client.includes('remove_background'), '客户端未注册 remove_background Toolview')

// Every emitted declaration/JS import must resolve inside the tarball.
for (const file of [...files].filter(name => name.endsWith('.js') || name.endsWith('.d.ts'))) {
  const source = await readFile(resolve(root, file), 'utf8')
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const target = relative(root, resolve(root, dirname(file), match[1]))
    const declaration = file.endsWith('.d.ts') && target.endsWith('.js') ? target.slice(0, -3) + '.d.ts' : ''
    assert.ok(!target.startsWith('..') && (files.has(target) || (declaration && files.has(declaration))), `${file} 引用了未打包的 ${target}`)
  }
}

const entry = await import(new URL('../' + p.main, import.meta.url))
assert.equal(entry.name, p.name)
assert.equal(typeof entry.apply, 'function')
console.log(`${pack.filename}: ${files.size} files; entry, client and model are self-contained`)
