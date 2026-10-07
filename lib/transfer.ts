export const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
const MAX_BUFFER = 1024 * 1024; // 1 MB buffer safety threshold

export interface FileHeader {
    type: "header";
    name: string;
    size: number;
    mimeType: string;
    totalChunks: number;
}

export interface TransferProgress {
    bytesTransferred: number;
    totalBytes: number;
    percentage: number;
    speedMBs: number;
}

export async function sendFile(
    file: File,
    channel: RTCDataChannel,
    onProgress?: (p: TransferProgress) => void,
    abortSignal?: AbortSignal
): Promise<void> {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const header: FileHeader = {
        type: "header",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        totalChunks,
    };
    channel.send(JSON.stringify(header));

    channel.bufferedAmountLowThreshold = 256 * 1024; // 256 KB resume point

    let offset = 0;
    let chunkIndex = 0;
    let lastTime = performance.now();
    let bytesSinceLastCheck = 0;
    let speedMBs = 0;

    while (offset < file.size) {
        if (abortSignal?.aborted) {
            channel.send(JSON.stringify({ type: "abort" }));
            throw new Error("Transfer cancelled");
        }

        if (channel.bufferedAmount > MAX_BUFFER) {
            await new Promise<void>((resolve) => {
                const handler = () => {
                    channel.removeEventListener("bufferedamountlow", handler);
                    resolve();
                };
                channel.addEventListener("bufferedamountlow", handler);
            });
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        channel.send(buffer);

        offset += buffer.byteLength;
        chunkIndex++;
        bytesSinceLastCheck += buffer.byteLength;

        const now = performance.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.5) {
            speedMBs = Number((bytesSinceLastCheck / (1024 * 1024) / elapsed).toFixed(1));
            lastTime = now;
            bytesSinceLastCheck = 0;
        }

        onProgress?.({
            bytesTransferred: offset,
            totalBytes: file.size,
            percentage: Math.min(100, Math.round((offset / file.size) * 100)),
            speedMBs,
        });
    }

    channel.send(JSON.stringify({ type: "complete" }));
}


export class FileReceiver {
    public header: FileHeader | null = null;
    private writable: FileSystemWritableFileStream | null = null;
    private opfsFile: FileSystemFileHandle | null = null;
    private bytesReceived = 0;
    private lastTime = performance.now();
    private bytesSinceLastCheck = 0;
    private speedMBs = 0;
    private onProgress?: (p: TransferProgress) => void;
    private onComplete?: (fileUrl?: string) => void;

    constructor(
        onProgress?: (p: TransferProgress) => void,
        onComplete?: (fileUrl?: string) => void
    ) {
        this.onProgress = onProgress;
        this.onComplete = onComplete;
    }

    public async prepareDisk(header: FileHeader): Promise<void> {
        this.header = header;
        this.bytesReceived = 0;

        if ("showSaveFilePicker" in window) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: header.name,
                });
                this.writable = await handle.createWritable();
                return;
            } catch (err) {
                console.warn("User dismissed picker or unsupported, falling back to OPFS", err);
            }
        }

        try {
            const root = await navigator.storage.getDirectory();
            this.opfsFile = await root.getFileHandle(header.name, { create: true });
            this.writable = await (this.opfsFile as any).createWritable();
        } catch (err) {
            console.error("Failed to initialize OPFS storage:", err);
        }
    }

    public async writeChunk(data: ArrayBuffer): Promise<void> {
        if (!this.writable || !this.header) return;

        await this.writable.write(data);
        this.bytesReceived += data.byteLength;
        this.bytesSinceLastCheck += data.byteLength;

        const now = performance.now();
        const elapsed = (now - lastTimeSafe(this.lastTime)) / 1000;
        if (elapsed >= 0.5) {
            this.speedMBs = Number((this.bytesSinceLastCheck / (1024 * 1024) / elapsed).toFixed(1));
            this.lastTime = now;
            this.bytesSinceLastCheck = 0;
        }

        this.onProgress?.({
            bytesTransferred: this.bytesReceived,
            totalBytes: this.header.size,
            percentage: Math.min(100, Math.round((this.bytesReceived / this.header.size) * 100)),
            speedMBs: this.speedMBs,
        });
    }

    public async finish(): Promise<void> {
        if (this.writable) {
            await this.writable.close();
            this.writable = null;
        }

        if (this.opfsFile) {
            const file = await this.opfsFile.getFile();
            const url = URL.createObjectURL(file);
            this.onComplete?.(url);
        } else {
            this.onComplete?.();
        }
    }

    public async abort(): Promise<void> {
        if (this.writable) {
            await this.writable.abort();
            this.writable = null;
        }
    }
}

function lastTimeSafe(time: number): number {
    return time === 0 ? performance.now() : time;
}
