import * as vscode from "vscode";

export class Logger {
    private rawLogUri: vscode.Uri | undefined;
    private rawLogContents = "";
    private rawLogFlush: ReturnType<typeof setTimeout> | undefined;
    private rawLogWrite = Promise.resolve();

    constructor(private writeEvent: vscode.EventEmitter<string>) { }

    public get rawMessageLogLocation() {
        return this.rawLogUri?.toString(true);
    }

    public info(text: string) {
        this.writeEvent.fire(`\u001b[36m${text}\u001b[0m`);
    }

    public error(text: string) {
        this.writeEvent.fire(`\u001b[31m${text}\u001b[0m`);
    }

    public log(text: string) {
        this.writeEvent.fire(text);
    }

    public configureRawMessageLog(logUri: vscode.Uri) {
        this.rawLogUri = logUri;
    }

    public rawMessage(direction: "in" | "out", transport: string, data: Uint8Array) {
        if (!this.rawLogUri) {
            return;
        }

        this.rawLogContents += `${JSON.stringify({
            timestamp: new Date().toISOString(),
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
}