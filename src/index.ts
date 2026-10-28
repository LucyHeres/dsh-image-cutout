import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import '@deepseek-ai/dsh-system-prompt'
import { cutoutTool } from './lib/cutout-tool.js'
import { disposeSessions } from './lib/cutout-engine.js'
import { models, type ModelId } from './lib/models.js'
import { CutoutRpc } from './lib/cutout-rpc.js'

export const name = 'dsh-image-cutout'
export const inject = ['tools', 'systemPrompt', 'skills']

export interface Config {
  modelDirectory: string
  defaultModel: ModelId
  maxBatch: number
}

export const Config: Schema<Config> = Schema.object({
  modelDirectory: Schema.string().default('').description('模型目录；留空使用插件包内 models/ 目录'),
  defaultModel: Schema.union(['fast', 'quality'] as const).default('fast').description('默认模型：fast 为 u2netp（约 4MB），quality 为 ISNet（约 176MB）'),
  maxBatch: Schema.number().default(50).description('单次批量处理的最大图片数量'),
})

/** Load the packaged skill, keeping catalog metadata and instructions in one file. */
function bundledSkill(skill: string): SkillRegistration {
  const directory = new URL(`../skills/${skill}/`, import.meta.url)
  const path = fileURLToPath(new URL('SKILL.md', directory))
  const document = readFileSync(path, 'utf8')
  const parsed = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(document)
  if (!parsed || parsed[1] !== skill) throw new Error(`Invalid bundled ${skill} skill`)
  return {
    name: parsed[1], description: parsed[2], content: parsed[3]!.trim(),
    source: 'bundled', provider: 'dsh-image-cutout', path,
    resourceBase: { kind: 'directory', path: fileURLToPath(directory) },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.effect(() => () => { void disposeSessions() })
  ctx.tools.register(cutoutTool({
    modelDirectory: config.modelDirectory,
    defaultModel: config.defaultModel,
    maxBatch: config.maxBatch,
  }))
  ctx.skills.register(bundledSkill('image-cutout'))
  new CutoutRpc(ctx, {
    modelDirectory: config.modelDirectory,
    defaultModel: config.defaultModel,
    maxBatch: config.maxBatch,
  })
  ctx.systemPrompt.section({
    name: 'plugin:image-cutout',
    order: 3240,
    interpolate: false,
    text: `本插件提供本地抠图能力 remove_background：用户要求抠图、去掉背景、生成透明底 PNG 或批量处理图片时使用。
图片只在本机推理，不得改用任何在线抠图/图床服务上传用户图片。
默认 model=fast（u2netp，速度约 0.5 秒/张，适合普通照片）；人像发丝、透明或复杂边缘、且插件已安装 quality 模型时可用 model=quality。
单张图片直接传文件路径；整个目录传目录路径并用 output 指定输出目录，不要逐张循环调用。默认输出写到原图同目录的 <原名>-cutout.png。
输出文件已存在时工具会报错，确认覆盖再传 overwrite=true；不要猜输出路径，用户没指定就省略 output。
可用模型：${Object.values(models).map(model => `${model.id}(${model.file})`).join('、')}。`.trim(),
  })
}
