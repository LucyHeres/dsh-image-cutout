/**
 * onnxruntime-node 1.20.1 publishes a `types` path but no declaration files,
 * so this declares only the surface this plugin uses.
 */
declare module 'onnxruntime-node' {
  export type TensorData = Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array

  export class Tensor {
    constructor(type: 'float32' | 'float64' | 'int32' | 'int64' | 'uint8', data: TensorData, dims?: readonly number[])
    readonly type: string
    readonly dims: readonly number[]
    readonly data: TensorData
  }

  export interface InferenceSession {
    readonly inputNames: readonly string[]
    readonly outputNames: readonly string[]
    run(feeds: Readonly<Record<string, Tensor>>, options?: Readonly<Record<string, unknown>>): Promise<Record<string, Tensor>>
    release?(): Promise<void>
  }

  export const InferenceSession: {
    create(path: string, options?: Readonly<Record<string, unknown>>): Promise<InferenceSession>
  }

  const ort: {
    Tensor: typeof Tensor
    InferenceSession: typeof InferenceSession
  }

  export default ort
}
