export const readBlobBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }
  // The stock Android 10 WebView only offers FileReader for binary reads.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

export const readBlobBase64 = (blob: Blob, timeoutMs?: number): Promise<string> => {
  if (blob.size === 0) {
    return Promise.resolve('')
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let settled = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return
            }
            settled = true
            try {
              reader.abort()
            } catch {
              // Ignore abort failures after timeout.
            }
            reject(new Error('Timed out reading local blob'))
          }, timeoutMs)
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
    reader.onload = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma === -1) {
        reject(new Error('Unexpected data URL while reading local blob'))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(reader.error ?? new Error('Unable to read local blob'))
    }
    reader.onabort = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(new Error('Aborted reading local blob'))
    }
    reader.readAsDataURL(blob)
  })
}

export async function* readBlobChunks(blob: Blob): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (typeof blob.stream !== 'function') {
    const chunkSize = 256 * 1024
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      yield new Uint8Array(await readBlobBuffer(blob.slice(offset, offset + chunkSize)))
    }
    return
  }

  const reader = blob.stream().getReader()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        return
      }
      yield value
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
