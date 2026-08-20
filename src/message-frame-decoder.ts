const HIGH_PRIORITY_DELIMITER = 0x01;
const MESSAGE_DELIMITER = 0x02;

export class MessageFrameDecoder {
    private _lowPriorityBuffer: number[] = [];
    private _highPriorityBuffer: number[] | undefined;

    public decode(chunk: Uint8Array): Uint8Array[] {
        const frames: Uint8Array[] = [];
        for (const byte of chunk) {
            if (byte === HIGH_PRIORITY_DELIMITER) {
                if (this._highPriorityBuffer) {
                    this._lowPriorityBuffer = [];
                }
                this._highPriorityBuffer = [byte];
                continue;
            }

            const activeBuffer = this._highPriorityBuffer ?? this._lowPriorityBuffer;
            activeBuffer.push(byte);

            if (byte !== MESSAGE_DELIMITER) {
                continue;
            }

            frames.push(Uint8Array.from(activeBuffer));
            if (this._highPriorityBuffer) {
                this._highPriorityBuffer = undefined;
            }
            else {
                this._lowPriorityBuffer = [];
            }
        }

        return frames;
    }

    public reset(): void {
        this._lowPriorityBuffer = [];
        this._highPriorityBuffer = undefined;
    }
}