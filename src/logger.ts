import * as vscode from "vscode";

export class Logger {
    private rawLogUri: vscode.Uri | undefined;
    private rawLogContents = "";
    private rawLogFlush: ReturnType<typeof setTimeout> | undefined;
    private rawLogWrite = Promise.resolve();
    private isAtLineStart = true;
    private output = "";
    private outputTruncated = false;

    constructor(
        private writeEvent: vscode.EventEmitter<string>,
        private now: () => Date = () => new Date(),
    ) { }

    public get rawMessageLogLocation() {
        return this.rawLogUri?.toString(true);
    }

    public clear() {
        this.isAtLineStart = true;
        this.output = "";
        this.outputTruncated = false;
        this.writeEvent.fire("\u001b[3J\u001b[2J\u001b[H");
    }

    public readOutput(maxCharacters = 16000): { text: string, truncated: boolean } {
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 32768) {
            throw new Error("maxCharacters must be an integer from 1 to 32768.");
        }
        return {
            text: this.output.slice(-maxCharacters),
            truncated: this.outputTruncated || this.output.length > maxCharacters,
        };
    }

    public info(text: string) {
        this.write(text, "\u001b[36m", "\u001b[0m");
    }

    public error(text: string) {
        this.write(text, "\u001b[31m", "\u001b[0m");
    }

    public log(text: string) {
        this.write(text);
    }

    public configureRawMessageLog(logUri: vscode.Uri) {
        this.rawLogUri = logUri;
    }

    public rawMessage(direction: "in" | "out", transport: string, data: Uint8Array) {
        if (!this.rawLogUri) {
            return;
        }

        this.rawLogContents += `${JSON.stringify({
            timestamp: this.now().toISOString(),
            direction,
            transport,
            data: [...data].map(byte => byte.toString(16).padStart(2, "0")).join(""),
        })}\n`;

        if (!this.rawLogFlush) {
            this.rawLogFlush = setTimeout(() => void this.flushRawMessageLog(), 250);
        }
    }

    public async flushRawMessageLog() {
        if (this.rawLogFlush) {
            clearTimeout(this.rawLogFlush);
            this.rawLogFlush = undefined;
        }
        if (!this.rawLogUri || !this.rawLogContents) {
            return;
        }

        const contents = new TextEncoder().encode(this.rawLogContents);
        this.rawLogWrite = this.rawLogWrite.then(() =>
            vscode.workspace.fs.writeFile(this.rawLogUri!, contents),
        );
        await this.rawLogWrite;
    }

    private addTimestamps(text: string): string {
        let timestampedText = "";

        for (const character of text) {
            if (this.isAtLineStart && character !== "\r" && character !== "\n") {
                timestampedText += `[${this.now().toISOString()}] `;
                this.isAtLineStart = false;
            }
            timestampedText += character;
            if (character === "\n") {
                this.isAtLineStart = true;
            }
        }

        return timestampedText;
    }

    private write(text: string, prefix = "", suffix = "") {
        const timestamped = this.addTimestamps(text);
        // Strip ANSI sequences emitted by programs as well as extension colors.
        const plainText = timestamped.replace(
            // eslint-disable-next-line no-control-regex
            /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/g,
            "",
        );
        this.output += plainText;
        if (this.output.length > 65536) {
            this.output = this.output.slice(-65536);
            this.outputTruncated = true;
        }
        this.writeEvent.fire(`${prefix}${timestamped}${suffix}`);
    }
}