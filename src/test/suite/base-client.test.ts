import * as assert from "assert";
import * as vscode from "vscode";

import { BaseClient, HubQuickPickItem } from "../../clients/base-client";
import { pack } from "../../cobs";
import { Logger } from "../../logger";
import { MessageFrameDecoder } from "../../message-frame-decoder";
import { InfoResponseMessage } from "../../messages/info-response-message";

class TestClient extends BaseClient {
    public timeoutMs = 10000;
    public write: () => Promise<void> | undefined = () => Promise.resolve();
    public writes = 0;

    protected get requestTimeoutMs() {
        return this.timeoutMs;
    }

    public get pendingCount() {
        return this._pendingMessagesPromises.size;
    }

    public setPacketSize(size: number) {
        this._infoResponse = new InfoResponseMessage();
        this._infoResponse.maxPacketSize = size;
    }

    public receive(bytes: number[]) {
        this.onData(pack(Uint8Array.from(bytes)));
    }

    public receiveFrame(bytes: number[]) {
        this.onData(Uint8Array.from(bytes));
    }

    public get isConnectedIn() {
        return true;
    }

    public get transport(): "bluetooth" {
        return "bluetooth";
    }

    public list(
        _onDidChange: (items: readonly HubQuickPickItem[]) => void,
        _cancellationToken: vscode.CancellationToken,
    ): Promise<HubQuickPickItem[]> {
        return Promise.resolve([]);
    }

    public connect(_peripheralUuid: string): Promise<void> {
        return Promise.resolve();
    }

    public disconnect(): Promise<void> {
        this.onDisconnect();
        return Promise.resolve();
    }

    public setIdentity(name: string, macAddress: string) {
        this._hubName = name;
        this._macAddress = macAddress;
    }

    protected writeData(_data: Uint8Array): Promise<void> | undefined {
        this.writes++;
        return this.write();
    }
}

suite("Base Client Test Suite", () => {
    const makeClient = () => {
        const client = new TestClient(new Logger(new vscode.EventEmitter<string>()));
        client.timeoutMs = 25;
        return client;
    };

    test("Completes acknowledged uploads and removes pending requests", async () => {
        const client = makeClient();
        const start = client.startFileUpload("program.py", 0, 0);
        client.receive([0x0d, 0]);
        await start;
        const chunk = client.transferChunk(Uint8Array.from([1, 2]), 0);
        client.receive([0x11, 0]);
        await chunk;
        assert.strictEqual(client.pendingCount, 0);
    });

    test("Rejects missing replies at every upload stage, including autostart", async () => {
        const requests = [
            (client: TestClient) => client.clearSlot(0),
            (client: TestClient) => client.startFileUpload("program.py", 0, 0),
            (client: TestClient) => client.transferChunk(Uint8Array.from([1]), 0),
            (client: TestClient) => client.startStopProgram(0),
        ];
        for (const request of requests) {
            const client = makeClient();
            await assert.rejects(request(client), /timed out/);
            assert.strictEqual(client.pendingCount, 0);
            await assert.rejects(client.clearSlot(0), /reconnect/);
        }
    });

    test("Disconnect settles a request even when its transport write is stalled", async () => {
        const client = makeClient();
        client.write = () => new Promise(() => { /* stalled transport */ });
        const request = client.startFileUpload("program.py", 0, 0);
        const rejected = assert.rejects(request, /disconnected/);
        await client.disconnect();
        await rejected;
        assert.strictEqual(client.pendingCount, 0);
    });

    test("Timeout covers transport writes and prevents later packets", async () => {
        const client = makeClient();
        client.setPacketSize(1);
        let finishWrite: (() => void) | undefined;
        client.write = () => new Promise(resolve => { finishWrite = resolve; });
        await assert.rejects(client.startFileUpload("program.py", 0, 0), /timed out/);
        finishWrite!();
        await Promise.resolve();
        assert.strictEqual(client.writes, 1);
        assert.strictEqual(client.pendingCount, 0);
    });

    test("An early reply does not bypass a stalled transport write", async () => {
        const client = makeClient();
        client.write = () => new Promise(() => { /* stalled transport */ });
        const request = client.startFileUpload("program.py", 0, 0);
        client.receive([0x0d, 0]);
        await assert.rejects(request, /timed out/);
        assert.strictEqual(client.pendingCount, 0);
    });

    test("Rejects transport errors and unavailable writers without leaving pending requests", async () => {
        for (const write of [
            () => Promise.reject(new Error("Write failed")),
            () => undefined,
        ]) {
            const client = makeClient();
            client.write = write;
            await assert.rejects(client.startFileUpload("program.py", 0, 0), /Write failed|unavailable/);
            assert.strictEqual(client.pendingCount, 0);
        }
    });

    test("Overlapping requests cannot overwrite the original promise", async () => {
        const client = makeClient();
        const first = client.startFileUpload("program.py", 0, 0);
        await assert.rejects(client.startFileUpload("program.py", 1, 0), /already pending/);
        client.receive([0x0d, 0]);
        await first;
        assert.strictEqual(client.pendingCount, 0);
    });

    test("Malformed replies reject the matching request immediately", async () => {
        const client = makeClient();
        const request = client.startFileUpload("program.py", 0, 0);
        client.receive([0x0d]);
        await assert.rejects(request, /Invalid hub response/);
        assert.strictEqual(client.pendingCount, 0);
    });

    test("Empty frames do not log errors or disturb pending replies", async () => {
        const emitter = new vscode.EventEmitter<string>();
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));
        const client = new TestClient(new Logger(emitter));
        const request = client.startFileUpload("program.py", 0, 0);

        for (const frame of [[0x02], [0x01, 0x02], [0x00, 0x02], [0x01, 0x00, 0x02]]) {
            client.receiveFrame(frame);
        }
        assert.deepStrictEqual(output, []);
        assert.strictEqual(client.pendingCount, 1);
        client.receive([0x0d, 0]);
        await request;
        assert.strictEqual(client.pendingCount, 0);

        subscription.dispose();
        emitter.dispose();
    });

    test("Malformed empty payloads still log their raw frame bytes", () => {
        const emitter = new vscode.EventEmitter<string>();
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));
        const client = new TestClient(new Logger(emitter));

        client.receiveFrame([0x10, 0x02]);

        assert.match(output.join(""), /Error deserializing message \(0 bytes: ; raw 2 bytes: 10 02\)/);
        subscription.dispose();
        emitter.dispose();
    });

    test("Preserves a fragmented burst of console and high-priority messages", () => {
        const emitter = new vscode.EventEmitter<string>();
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));
        const client = new TestClient(new Logger(
            emitter,
            () => new Date("2026-11-14T23:08:07.689Z"),
        ));
        const running: boolean[] = [];
        const runningSubscription = client.onProgramRunningChanged.event(value => running.push(value));
        const decoder = new MessageFrameDecoder();
        const wire: number[] = [];
        const expectedOutput: string[] = [];
        const expectedRunning: boolean[] = [];

        for (let i = 0; i < 500; i++) {
            const text = `${i}: ${"x".repeat(180)}\r\n`;
            const consoleFrame = pack(Uint8Array.from([0x21, ...new TextEncoder().encode(text)]));
            const split = Math.floor(consoleFrame.length / 2);
            wire.push(
                ...consoleFrame.slice(0, split),
                0x01, ...pack(Uint8Array.from([0x20, i % 2])),
                ...consoleFrame.slice(split),
                0x02, 0x00, 0x02,
            );
            expectedOutput.push(`[2026-11-14T23:08:07.689Z] ${text}`);
            expectedRunning.push(i % 2 === 0);
        }
        const chunkSizes = [1, 7, 20, 64];
        for (let offset = 0, chunk = 0; offset < wire.length; chunk++) {
            const size = chunkSizes[chunk % chunkSizes.length];
            for (const frame of decoder.decode(Uint8Array.from(wire.slice(offset, offset + size)))) {
                client.receiveFrame([...frame]);
            }
            offset += size;
        }

        assert.deepStrictEqual(output, expectedOutput);
        assert.deepStrictEqual(running, expectedRunning);
        subscription.dispose();
        runningSubscription.dispose();
        emitter.dispose();
    });

    test("Invalid packet sizes fail before starting a request", async () => {
        for (const size of [0, -1, NaN, 0.5]) {
            const client = makeClient();
            client.setPacketSize(size);
            await assert.rejects(client.startFileUpload("program.py", 0, 0), /Invalid hub packet size/);
            assert.strictEqual(client.pendingCount, 0);
            assert.strictEqual(client.writes, 0);
        }
    });

    test("Logs connected hub identity before disconnect cleanup", async () => {
        const emitter = new vscode.EventEmitter<string>();
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));
        const client = new TestClient(new Logger(
            emitter,
            () => new Date("2026-09-07T12:34:56.789Z"),
        ));

        client.setIdentity("My Hub", "AA:BB:CC:DD:EE:FF");
        client.logConnected();
        await client.disconnect();

        assert.strictEqual(
            output.join(""),
            "\u001b[36m[2026-09-07T12:34:56.789Z] Connected to hub My Hub (MAC AA:BB:CC:DD:EE:FF).\r\n\u001b[0m" +
                "\u001b[36m[2026-09-07T12:34:56.789Z] Disconnected from hub My Hub (MAC AA:BB:CC:DD:EE:FF).\r\n\u001b[0m",
        );

        subscription.dispose();
        emitter.dispose();
    });

    test("Does not log disconnect before a connection is established", async () => {
        const emitter = new vscode.EventEmitter<string>();
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));
        const client = new TestClient(new Logger(
            emitter,
            () => new Date("2026-09-07T12:34:56.789Z"),
        ));

        await client.disconnect();

        assert.deepStrictEqual(output, []);

        subscription.dispose();
        emitter.dispose();
    });
});