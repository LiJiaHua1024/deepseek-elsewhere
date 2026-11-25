import type { InlineFileBlockParam, TextBlockParam } from '../../services/api/types.js'

export type ProcessedAttachmentBlock = InlineFileBlockParam | TextBlockParam

export type AttachmentCacheEntry = {
  blocks: ProcessedAttachmentBlock[]
  bytes: number
  nativePdf?: boolean
  truncated?: { totalPages: number; renderedPages: number }
}

const MAX_ENTRIES = 8
const MAX_BYTES = 24 * 1024 * 1024

export class AttachmentPreprocessCache {
  private entries = new Map<string, AttachmentCacheEntry>()

  get(key: string): AttachmentCacheEntry | undefined {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: AttachmentCacheEntry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.evict()
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }

  private evict() {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {return}
      this.entries.delete(oldest)
    }
    let total = 0
    for (const entry of this.entries.values()) {total += entry.bytes}
    while (total > MAX_BYTES && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) {return}
      const oldest = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      total -= oldest?.bytes ?? 0
    }
  }
}

export const attachmentPreprocessCache = new AttachmentPreprocessCache()

export const estimateAttachmentBlocksBytes = (blocks: ProcessedAttachmentBlock[]) =>
  blocks.reduce(
    (total, block) =>
      total + (block.type === 'text' ? block.text.length * 2 : block.source.data.length),
    0
  )
