import * as assert from "assert";
import * as vscode from "vscode";

import { BaseClient } from "../../clients/base-client";
import {
    clearProgramSlot,
    getClient,
    getLogger,
    initClient,
    registerHubPopup,
    startProgramInSlot,
    uploadFileToHub,
    withHubOperation,
    withUploadProgress,
} from "../../shared-extension";

class UploadTestClient extends BaseClient {
    public chunkSize: number | undefined = 2;
    public connected = true;
    public clearAcknowledged = true;
    public startCount = 0;
    public chunks: Uint8Array[] = [];
    public chunkError: Error | undefined;
    public startProgram: () => Promise<boolean> = async () => true;

    public get isConnectedIn() {
        return this.connected;
    }

    public get transport(): "usb" {
        return "usb";
    }

    public get maxChunkSize() {
        return this.chunkSize;
    }

    public async list() {
        return [];
    }

    public async connect() {
        this.connected = true;
    }

    public async disconnect() {
        this.connected = false;
        this.onDisconnect();
    }

    public async clearSlot() {
        return this.clearAcknowledged;
    }

    public async startFileUpload() {
        this.startCount++;
    }

    public async transferChunk(chunk: Uint8Array) {
        if (this.chunkError) {
            throw this.chunkError;
        }

        this.chunks.push(chunk);
    }

    public startStopProgram() {
        return this.startProgram();
    }

    protected async writeData() {
        throw new Error("Unexpected transport write in upload test.");
    }
}

suite("Upload Progress Test Suite", () => {
    let client: UploadTestClient;
    const options = {
        location: vscode.ProgressLocation.Notification,
        title: "Testing upload progress",
    };

    setup(() => {
        initClient(UploadTestClient);
        const initialized = getClient();
        assert.ok(initialized instanceof UploadTestClient);
        client = initialized;
    });

    test("Uploads chunks and reports completion", async () => {
        const increments: number[] = [];
        await uploadFileToHub(Uint8Array.from([1, 2, 3]), "program.py", 0, {
            report: value => increments.push(value.increment),
        });
        assert.strictEqual(client.startCount, 1);
        assert.deepStrictEqual(client.chunks, [Uint8Array.from([1, 2]), Uint8Array.from([3])]);
        assert.deepStrictEqual(increments, [50, 50]);
    });

    test("Invalid chunk sizes fail without opening a transfer or looping", async () => {
        for (const size of [undefined, 0, -1, NaN, 0.5]) {
            client.chunkSize = size;
            await assert.rejects(uploadFileToHub(Uint8Array.from([1]), "program.py", 0), /Invalid hub upload chunk size/);
            assert.strictEqual(client.startCount, 0);
        }
    });

    test("Disconnected hubs fail before starting an upload", async () => {
        client.connected = false;
        await assert.rejects(uploadFileToHub(Uint8Array.from([1]), "program.py", 0), /disconnected/);
    });

    test("A rejected slot clear stops the upload", async () => {
        client.clearAcknowledged = false;
        await assert.rejects(clearProgramSlot(0), /Failed to clear program slot/);
    });

    test("Concurrent uploads are rejected and the lock clears on completion", async () => {
        let finish: (() => void) | undefined;
        let entered: (() => void) | undefined;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const first = withUploadProgress(options, () => new Promise<void>(resolve => {
            finish = resolve;
            entered!();
        }));
        await started;
        await assert.rejects(withUploadProgress(options, async () => { /* second upload */ }), /already in progress/);
        finish!();
        await first;
        await withUploadProgress(options, async () => { /* subsequent upload */ });
    });

    test("A failed chunk settles progress and releases the upload lock", async () => {
        client.chunkError = new Error("Hub disconnected during a request.");
        await assert.rejects(
            withUploadProgress(options, () => uploadFileToHub(Uint8Array.from([1]), "program.py", 0)),
            /disconnected/,
        );
        client.chunkError = undefined;
        await withUploadProgress(options, () => uploadFileToHub(Uint8Array.from([1]), "program.py", 0));
    });

    test("Disconnect closes stalled progress and releases the lock before old work finishes", async () => {
        let finishOldWork!: () => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        let continued = false;
        const oldUpload = withUploadProgress(options, async (progress, operation) => {
            entered();
            await operation.wait(() => new Promise<void>(resolve => { finishOldWork = resolve; }));
            continued = true;
            await clearProgramSlot(0, operation);
        });
        await started;
        const rejected = assert.rejects(oldUpload, /disconnected/);
        const disconnected = client.disconnect();

        initClient(UploadTestClient);
        let finishNewWork!: () => void;
        let enteredNew!: () => void;
        const newStarted = new Promise<void>(resolve => { enteredNew = resolve; });
        const newUpload = withUploadProgress(options, () => new Promise<void>(resolve => {
            finishNewWork = resolve;
            enteredNew();
        }));
        await newStarted;
        await disconnected;
        await rejected;
        finishOldWork();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(continued, false);
        await assert.rejects(withUploadProgress(options, async () => { /* concurrent upload */ }), /already in progress/);
        finishNewWork();
        await newUpload;
        await withUploadProgress(options, async () => { /* subsequent upload */ });
    });

    test("Disconnect settles a stalled program start", async () => {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        client.startProgram = () => {
            entered();
            return new Promise(() => { /* stalled request */ });
        };
        const start = startProgramInSlot(2);
        await started;
        const rejected = assert.rejects(start, /disconnected/);
        await client.disconnect();
        await rejected;
    });

    test("Chat cancellation settles a stalled start without disconnecting the hub", async () => {
        const cancellation = new vscode.CancellationTokenSource();
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        client.startProgram = () => {
            entered();
            return new Promise(() => { /* stalled request */ });
        };
        try {
            const start = withHubOperation(operation => startProgramInSlot(2, false, operation), client, cancellation.token);
            await started;
            const rejected = assert.rejects(start, error => error instanceof vscode.CancellationError);
            cancellation.cancel();
            await rejected;
            assert.strictEqual(client.isConnectedIn, true);
        }
        finally {
            cancellation.dispose();
        }
    });

    test("Program execution clears the terminal by default and respects disabling it", async () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        const logger = getLogger();
        const originalClear = logger.clear;
        let clearCount = 0;
        let enabled: boolean | undefined;
        vscode.workspace.getConfiguration = (section, ...args) => {
            const configuration = originalGetConfiguration(section, ...args);
            if (section === "legoSpikePrimeMindstorms") {
                return new Proxy({ ...configuration }, {
                    get: (target, property) => {
                        if (property === "get") {
                            return (key: string, defaultValue?: unknown) => key === "clearTerminalOnExecution"
                                ? enabled ?? defaultValue
                                : target.get(key, defaultValue);
                        }
                        return Reflect.get(target, property);
                    },
                });
            }
            return configuration;
        };
        logger.clear = () => { clearCount++; };

        try {
            for (const setting of [undefined, false, true]) {
                enabled = setting;
                const before = clearCount;
                client.startProgram = async () => {
                    assert.strictEqual(clearCount, before + (setting === false ? 0 : 1));
                    return true;
                };
                await startProgramInSlot(2, setting !== true);
            }
            assert.strictEqual(clearCount, 2);
            await startProgramInSlot(NaN);
            assert.strictEqual(clearCount, 2);
            await uploadFileToHub(Uint8Array.from([1]), "program.py", 0);
            assert.strictEqual(clearCount, 2);
        }
        finally {
            vscode.workspace.getConfiguration = originalGetConfiguration;
            logger.clear = originalClear;
        }
    });

    test("Disconnect settles the running notification without opening duplicate progress", async () => {
        const original = vscode.window.withProgress;
        const running: Array<Promise<void>> = [];
        vscode.window.withProgress = (progressOptions, task) => {
            const result = original(progressOptions, task);
            if (progressOptions.title?.startsWith("Running Program")) {
                running.push(Promise.resolve(result).then(() => { /* notification completed */ }));
            }
            return result;
        };
        try {
            await startProgramInSlot(2);
            client.onProgramRunningChanged.fire(true);
            client.onProgramRunningChanged.fire(true);
            assert.strictEqual(running.length, 1);
            await client.disconnect();
            await running[0];
            client.onProgramRunningChanged.fire(true);
            assert.strictEqual(running.length, 1);
        }
        finally {
            vscode.window.withProgress = original;
        }
    });

    test("Disconnect closes registered hub popups and cancels waiting operations", async () => {
        let closed = false;
        const popup = registerHubPopup(() => { closed = true; });
        const waiting = withHubOperation(operation => operation.wait(() => new Promise(() => { /* waiting for input */ })));
        const rejected = assert.rejects(waiting, /disconnected/);
        await client.disconnect();
        await rejected;
        assert.strictEqual(closed, true);
        popup.dispose();
    });
});
