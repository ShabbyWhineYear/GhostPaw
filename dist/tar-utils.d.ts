/**
 * Zero-dependency POSIX .tar.gz / .tgz extractor in pure TypeScript.
 */
export declare function extractTarGzBuffer(tgzBuffer: Buffer): Map<string, {
    readonly data: Buffer;
    readonly mode: number;
}>;
