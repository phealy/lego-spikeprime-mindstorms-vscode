import * as assert from "assert";
import * as vscode from "vscode";

import { BaseClient } from "../../clients/base-client";
import {
    clearProgramSlot,
    getClient,
    initClient,
    uploadFileToHub,
    withUploadProgress,
} from "../../shared-extension";

class UploadTestClient extends BaseClient {
    public chunkSize: number | undefined = 2;
    public connected = true;
    public clearAcknowledged = true;
    public startCount = 0;
    public chunks: Uint8Array[] = [];
    public chunkError: Error | undefined;

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
});
