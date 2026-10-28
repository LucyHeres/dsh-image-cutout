import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ModelId = 'fast' | 'quality'

export interface ModelSpec {
  id: ModelId
  file: string
  /** Square inference resolution the weights were trained for. */
  size: number
  mean: readonly [number, number, number]
  std: readonly [number, number, number]
}

/** u2netp is Apache-2.0 U^2-Net weights; ISNet general-use is Apache-2.0 DIS weights. */
export const models: Record<ModelId, ModelSpec> = {
  fast: { id: 'fast', file: 'u2netp.onnx', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  quality: { id: 'quality', file: 'isnet-general-use.onnx', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1] },
}

export const defaultModelDirectory = () => fileURLToPath(new URL('../../models/', import.meta.url))

export function modelPath(id: ModelId, directory?: string) {
  return join(directory?.trim() ? directory : defaultModelDirectory(), models[id].file)
}

export function assertModel(id: ModelId, directory?: string) {
  const path = modelPath(id, directory)
  if (!existsSync(path)) {
    throw new Error(`抠图模型缺失：${path}。两个模型都随插件打包，缺失说明安装不完整，请重新安装 dsh-image-cutout；或在插件配置中把 modelDirectory 指向本地模型目录。`)
  }
  return path
}
