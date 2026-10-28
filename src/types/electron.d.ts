/** Minimal shape of the Electron APIs used by the standalone page, loaded with a guarded dynamic import. */
declare module 'electron' {
  export const dialog: {
    showOpenDialog(options: {
      title?: string
      properties?: string[]
      filters?: { name: string; extensions: string[] }[]
    }): Promise<{ canceled: boolean; filePaths: string[] }>
  }
  export const shell: {
    showItemInFolder(fullPath: string): void
  }
}
