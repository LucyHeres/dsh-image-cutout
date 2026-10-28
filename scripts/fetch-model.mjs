import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const target = fileURLToPath(new URL('../models/isnet-general-use.onnx', import.meta.url))
const expected = 176_000_000
const url = process.env.CUTOUT_QUALITY_MODEL_URL || 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'

if (existsSync(target) && (await stat(target)).size > expected * 0.9) {
  console.log(`已存在：${target}`)
  process.exit(0)
}
await mkdir(dirname(target), { recursive: true })
const partial = `${target}.part`
console.log(`下载 quality 模型（约 176MB）→ ${target}`)
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
let received = 0
let lastReport = 0
const stream = Readable.fromWeb(response.body)
stream.on('data', chunk => {
  received += chunk.length
  const now = Date.now()
  if (now - lastReport > 2000) {
    lastReport = now
    console.log(`  ${(received / 1024 / 1024).toFixed(1)} MB`)
  }
})
try {
  await pipeline(stream, createWriteStream(join(partial)))
  const size = (await stat(partial)).size
  if (size < expected * 0.9) throw new Error(`文件不完整：${size} 字节`)
  await rename(partial, target)
  console.log(`完成：${target}（${(size / 1024 / 1024).toFixed(1)} MB）`)
} catch (error) {
  await rm(partial, { force: true })
  throw error
}
