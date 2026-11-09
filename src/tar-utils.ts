import { gunzipSync } from 'node:zlib'

/**
 * Zero-dependency POSIX .tar.gz / .tgz extractor in pure TypeScript.
 */
export function extractTarGzBuffer(tgzBuffer: Buffer): Map<string, { readonly data: Buffer; readonly mode: number }> {
  const tarBuf = gunzipSync(tgzBuffer)
  const files = new Map<string, { readonly data: Buffer; readonly mode: number }>()
  let offset = 0

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    let isZeroBlock = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZeroBlock = false
        break
      }
    }
    if (isZeroBlock) break

    const readNullTermString = (start: number, length: number): string => {
      const slice = header.subarray(start, start + length)
      const zeroIdx = slice.indexOf(0)
      return (zeroIdx >= 0 ? slice.subarray(0, zeroIdx) : slice).toString('utf8').trim()
    }

    const rawName = readNullTermString(0, 100)
    const prefix = readNullTermString(345, 155)
    const fullName = prefix ? `${prefix}/${rawName}` : rawName
    const modeOctal = readNullTermString(100, 8)
    const sizeOctal = readNullTermString(124, 12)
    const typeFlag = header[156]

    const mode = Number.parseInt(modeOctal, 8) || 0o644
    const size = Number.parseInt(sizeOctal, 8) || 0

    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const paddedSize = Math.ceil(size / 512) * 512
    offset = dataStart + paddedSize

    const isRegularFile = typeFlag === 0 || typeFlag === 48
    if (!isRegularFile || !fullName || dataEnd > tarBuf.length) {
      continue
    }

    const relPath = fullName.replace(/^package\//, '').replace(/^\/+/, '')
    if (!relPath || relPath.includes('..')) continue

    files.set(relPath, {
      data: Buffer.from(tarBuf.subarray(dataStart, dataEnd)),
      mode,
    })
  }

  return files
}
