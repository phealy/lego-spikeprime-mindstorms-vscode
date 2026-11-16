import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { registerChatConnectionTools } from "../../chat-connection-tools";
import { registerChatTools } from "../../chat-tools";
import { BaseClient } from "../../clients/base-client";
import { DeviceNotificationMessage } from "../../messages/device-notification";
import { DeviceNotificationResponseMessage } from "../../messages/device-notification-response";
import { ProgramRuns } from "../../program-runs";
import {
    getClient,
    getLogger,
    initClient,
} from "../../shared-extension";

class ChatTestClient extends BaseClient {
    public connected = true;
    public transportType: "bluetooth" | "usb" = "usb";
    public acknowledged = true;
    public requests: Array<{ slot: number, stop: boolean }> = [];
    public telemetryRequestCount = 0;
    public requestTelemetry: () => Promise<DeviceNotificationResponseMessage> = async () => new DeviceNotificationResponseMessage();
    public onStart: (() => void) | undefined;

    public get isConnectedIn() {
        return this.connected;
    }

    public get transport(): "bluetooth" | "usb" {
        return this.transportType;
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

    public async startStopProgram(slot: number, stop = false) {
        this.requests.push({ slot, stop });
        if (!stop) {
            this.onStart?.();
        }
        return this.acknowledged;
    }

    public async startDeviceNotifications() {
        this.telemetryRequestCount++;
        return this.requestTelemetry();
    }

    protected async writeData() {
        throw new Error("Unexpected transport write in chat tool test.");
    }
}

suite("Chat Tools Test Suite", () => {
    const originalRegister = vscode.lm.registerTool;
    const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
    const tools = new Map<string, vscode.LanguageModelTool<unknown>>();
    let client: ChatTestClient;
    let cancellation: vscode.CancellationTokenSource;
    let programUri: vscode.Uri;
    let subscriptions: vscode.Disposable[];
    let uploaded: { file: string, slot: number, includes: string[] } | undefined;
    let uploadError: Error | undefined;
    let duringUpload: (() => void) | undefined;
    let connectionCalls: Array<{ transport: string, id: string | undefined }>;
    let scanDuration: number | undefined;

    setup(async () => {
        initClient(ChatTestClient);
        const initialized = getClient();
        assert.ok(initialized instanceof ChatTestClient);
        client = initialized;
        cancellation = new vscode.CancellationTokenSource();
        subscriptions = [];
        uploaded = undefined;
        uploadError = undefined;
        duringUpload = undefined;
        connectionCalls = [];
        scanDuration = undefined;
        getLogger().clear();
        programUri = vscode.Uri.file(path.join(os.tmpdir(), `chat-tool-${Date.now()}.py`));
        vscode.workspace.getWorkspaceFolder = uri => uri.toString() === programUri.toString()
            ? { uri: vscode.Uri.joinPath(programUri, ".."), name: "Chat tool test workspace", index: 0 }
            : undefined;
        await vscode.workspace.fs.writeFile(programUri, new TextEncoder().encode(
            "# LEGO slot:5 include:helper.py autostart\nprint('hello')\n",
        ));
        vscode.lm.registerTool = (name, tool) => {
            tools.set(name, tool);
            return new vscode.Disposable(() => tools.delete(name));
        };
        registerChatTools({ subscriptions }, async (document, slot, includes, progress, operation) => {
            if (uploadError) {
                throw uploadError;
            }
            uploaded = { file: document.uri.toString(), slot, includes };
            duringUpload?.();
            operation.check();
        });
        registerChatConnectionTools({ subscriptions }, {
            scanUsb: async token => [{ label: "COM3", connectionId: "serial-id", description: "serial-id" }],
            scanBle: async (duration, token) => {
                scanDuration = duration;
                return [{ label: "My Hub", connectionId: "ble-id" }];
            },
            connectBle: async (id, token) => {
                connectionCalls.push({ transport: "bluetooth", id });
                initClient(ChatTestClient);
                const bleClient = getClient();
                assert.ok(bleClient instanceof ChatTestClient);
                client = bleClient;
                client.transportType = "bluetooth";
                client.connected = true;
            },
            connectUsb: async (id, token) => {
                connectionCalls.push({ transport: "usb", id });
                initClient(ChatTestClient);
                const usbClient = getClient();
                assert.ok(usbClient instanceof ChatTestClient);
                client = usbClient;
                client.transportType = "usb";
                client.connected = true;
            },
        });
    });

    teardown(async () => {
        vscode.lm.registerTool = originalRegister;
        vscode.workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
        subscriptions.forEach(subscription => subscription.dispose());
        cancellation.dispose();
        await client.disconnect();
        await vscode.workspace.fs.delete(programUri, { useTrash: false });
    });

    const getTool = (name: string): vscode.LanguageModelTool<unknown> => {
        const tool = tools.get(name);
        assert.ok(tool, `Missing tool ${name}`);
        return tool;
    };

    const invoke = async (name: string, input: object): Promise<object> => {
        const output = await getTool(name).invoke({
            input,
            toolInvocationToken: undefined,
        }, cancellation.token);
        assert.ok(output instanceof vscode.LanguageModelToolResult);
        const [text] = output.content;
        assert.ok(text instanceof vscode.LanguageModelTextPart);
        return JSON.parse(text.value);
    };

    test("Uploads the specified file without honoring header autostart or changing the editor", async () => {
        const editor = vscode.window.activeTextEditor;
        const output = await invoke("lego_upload_program", { filePath: programUri.fsPath, slot: 3 });
        assert.deepStrictEqual(uploaded, { file: programUri.toString(), slot: 3, includes: ["helper.py"] });
        assert.deepStrictEqual(client.requests, []);
        assert.deepStrictEqual(output, { uploaded: true, started: false, slot: 3, file: programUri.toString(true) });
        assert.strictEqual(vscode.window.activeTextEditor, editor);
    });

    test("Explicit upload-and-run starts only after uploading, and returns hub acknowledgment", async () => {
        duringUpload = () => assert.deepStrictEqual(client.requests, []);
        const output = await invoke("lego_upload_program", { filePath: programUri.toString(), slot: 5, run: true, waitForCompletion: false });
        assert.ok("runId" in output && typeof output.runId === "string");
        assert.ok(uploaded);
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }]);
        assert.deepStrictEqual(output, { uploaded: true, started: true, slot: 5, file: programUri.toString(true), runId: output.runId });
    });

    test("Saves the requested dirty document before the upload pipeline reads it", async () => {
        const document = await vscode.workspace.openTextDocument(programUri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(programUri, new vscode.Position(1, 0), "# edited in VS Code\n");
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(document.isDirty, true);
        duringUpload = () => assert.strictEqual(document.isDirty, false);
        await invoke("lego_upload_program", { filePath: programUri.fsPath, slot: 5 });
        const saved = new TextDecoder().decode(await vscode.workspace.fs.readFile(programUri));
        assert.ok(saved.includes("# edited in VS Code\n"));
    });

    test("Start and stop use explicit slots; rejected hub acknowledgments fail the tool", async () => {
        const started = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in started && typeof started.runId === "string");
        assert.deepStrictEqual(started, { slot: 5, started: true, runId: started.runId });
        assert.deepStrictEqual(await invoke("lego_stop_program", { slot: 5 }), { slot: 5, stopped: true });
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }, { slot: 5, stop: true }]);
        client.acknowledged = false;
        await assert.rejects(invoke("lego_start_program", { slot: 5 }), /not acknowledged/);
        await assert.rejects(invoke("lego_stop_program", { slot: 5 }), /not acknowledged/);
    });

    test("Upload failures and cancellation never proceed to program start", async () => {
        const input = { filePath: programUri.fsPath, slot: 5, run: true };
        uploadError = new Error("Compilation failed");
        await assert.rejects(invoke("lego_upload_program", input), /Compilation failed/);
        uploadError = undefined;
        duringUpload = () => cancellation.cancel();
        await assert.rejects(invoke("lego_upload_program", input), error => error instanceof vscode.CancellationError);
        assert.deepStrictEqual(client.requests, []);
    });

    test("Wait resumes on actual termination and includes timestamped output, not start acknowledgment", async () => {
        const started = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in started);
        let settled = false;
        const waiting = invoke("lego_wait_program", { runId: started.runId }).then(output => {
            settled = true;
            return output;
        });
        client.onProgramRunningChanged.fire(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(settled, false);
        getLogger().log("Traceback: test exception\r\n");
        client.onProgramRunningChanged.fire(false);
        const ended = await waiting;
        assert.ok("startedAt" in ended && typeof ended.startedAt === "string");
        assert.ok("endedAt" in ended && typeof ended.endedAt === "string");
        assert.ok(Date.parse(ended.endedAt) >= Date.parse(ended.startedAt));
        assert.deepStrictEqual(ended, {
            runId: started.runId,
            slot: 5,
            state: "terminated",
            startedAt: ended.startedAt,
            endedAt: ended.endedAt,
            logs: getLogger().readOutput(),
            timedOut: false,
        });
    });

    test("Wait remembers termination before start acknowledgment and preserves logs across later runs", async () => {
        client.onStart = () => {
            getLogger().log("fast output\r\n");
            client.onProgramRunningChanged.fire(true);
            client.onProgramRunningChanged.fire(false);
        };
        const started = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in started);
        const ended = await invoke("lego_wait_program", { runId: started.runId });
        assert.ok("state" in ended && ended.state === "terminated");
        client.onStart = undefined;
        await invoke("lego_start_program", { slot: 6, waitForCompletion: false });
        getLogger().log("later output\r\n");
        assert.deepStrictEqual(await invoke("lego_wait_program", { runId: started.runId }), ended);
    });

    test("Wait returns disconnect or superseded without claiming normal completion", async () => {
        const first = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in first);
        const waiting = invoke("lego_wait_program", { runId: first.runId });
        await invoke("lego_start_program", { slot: 6, waitForCompletion: false });
        const replaced = await waiting;
        assert.ok("state" in replaced && replaced.state === "superseded");
        const second = await invoke("lego_start_program", { slot: 7, waitForCompletion: false });
        assert.ok("runId" in second);
        const disconnected = invoke("lego_wait_program", { runId: second.runId });
        await client.disconnect();
        const ended = await disconnected;
        assert.ok("state" in ended && ended.state === "disconnected");
        assert.deepStrictEqual(await invoke("lego_wait_program", { runId: second.runId }), ended);
    });

    test("Wait timeout and cancellation leave execution tracked for a later wait", async () => {
        const started = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in started);
        client.onProgramRunningChanged.fire(true);
        const before = Date.now();
        const timed = await invoke("lego_wait_program", { runId: started.runId, timeoutSeconds: 1 });
        assert.ok(Date.now() - before >= 1000);
        assert.ok("timedOut" in timed && timed.timedOut === true);
        assert.ok("state" in timed && timed.state === "running");
        assert.strictEqual("endedAt" in timed, false);
        const cancelled = invoke("lego_wait_program", { runId: started.runId });
        const rejected = assert.rejects(cancelled, error => error instanceof vscode.CancellationError);
        cancellation.cancel();
        await rejected;
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }]);
        cancellation.dispose();
        cancellation = new vscode.CancellationTokenSource();
        client.onProgramRunningChanged.fire(false);
        const ended = await invoke("lego_wait_program", { runId: started.runId });
        assert.ok("state" in ended && ended.state === "terminated");
        assert.ok("timedOut" in ended && ended.timedOut === false);
    }).timeout(5000);

    test("Wait rejects unknown run IDs and invalid timeout bounds", async () => {
        await assert.rejects(invoke("lego_wait_program", { runId: "invented" }), /Unknown or expired/);
        const started = await invoke("lego_start_program", { slot: 5, waitForCompletion: false });
        assert.ok("runId" in started);
        for (const timeoutSeconds of [0, 301, 1.5, NaN]) {
            await assert.rejects(invoke("lego_wait_program", { runId: started.runId, timeoutSeconds }), /timeoutSeconds/);
        }
    });

    test("Run tracker preserves failed starts and expires history after 100 newer starts", async () => {
        const tracker = new ProgramRuns(() => ({ text: "error output", truncated: false }));
        const failedId = tracker.begin(client, 5);
        tracker.fail(failedId, new Error("Hub refused the request"));
        const failed = await tracker.wait(failedId, 1, cancellation.token);
        assert.strictEqual(failed.state, "startFailed");
        assert.strictEqual(failed.error, "Hub refused the request");
        assert.deepStrictEqual(failed.logs, { text: "error output", truncated: false });
        for (let index = 0; index < 100; index++) {
            const id = tracker.begin(client, 5);
            client.onProgramRunningChanged.fire(false);
            assert.strictEqual((await tracker.wait(id, 1, cancellation.token)).state, "terminated");
        }
        await assert.rejects(tracker.wait(failedId, 1, cancellation.token), /Unknown or expired/);
    });

    test("Start waits for termination by default and returns completion in the same tool call", async () => {
        let settled = false;
        const starting = invoke("lego_start_program", { slot: 5 }).then(startResult => {
            settled = true;
            return startResult;
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(settled, false);
        client.onProgramRunningChanged.fire(true);
        getLogger().log("finished run\r\n");
        client.onProgramRunningChanged.fire(false);
        const output = await starting;
        assert.ok("runId" in output && typeof output.runId === "string");
        assert.ok("completion" in output && typeof output.completion === "object" && output.completion !== null);
        assert.ok("state" in output.completion && output.completion.state === "terminated");
        assert.deepStrictEqual(output.completion, await invoke("lego_wait_program", { runId: output.runId }));
    });

    test("Start-and-wait handles immediate termination, validates timeout before starting and never stops on cancellation", async () => {
        await assert.rejects(invoke("lego_start_program", { slot: 5, timeoutSeconds: 0 }), /timeoutSeconds/);
        assert.deepStrictEqual(client.requests, []);
        client.onStart = () => client.onProgramRunningChanged.fire(false);
        const fast = await invoke("lego_start_program", { slot: 5, waitForCompletion: true });
        assert.ok("completion" in fast && typeof fast.completion === "object" && fast.completion !== null);
        assert.ok("state" in fast.completion && fast.completion.state === "terminated");
        client.onStart = undefined;
        const waiting = invoke("lego_start_program", { slot: 6, waitForCompletion: true });
        await new Promise(resolve => setTimeout(resolve, 0));
        const rejected = assert.rejects(waiting, error => error instanceof vscode.CancellationError);
        cancellation.cancel();
        await rejected;
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }, { slot: 6, stop: false }]);
    });

    test("Upload-and-run waits by default, while upload-only ignores completion wait options", async () => {
        await assert.rejects(invoke("lego_upload_program", {
            filePath: programUri.fsPath, slot: 5, run: true, timeoutSeconds: 0,
        }), /timeoutSeconds/);
        assert.strictEqual(uploaded, undefined);
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        client.onStart = () => {
            client.onProgramRunningChanged.fire(true);
            entered();
        };
        let settled = false;
        const uploading = invoke("lego_upload_program", {
            filePath: programUri.fsPath, slot: 5, run: true,
        }).then(uploadResult => {
            settled = true;
            return uploadResult;
        });
        await started;
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(settled, false);
        getLogger().log("uploaded run finished\r\n");
        client.onProgramRunningChanged.fire(false);
        const output = await uploading;
        assert.ok("runId" in output);
        assert.ok("completion" in output);
        assert.deepStrictEqual(output.completion, await invoke("lego_wait_program", { runId: output.runId }));
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }]);
        const uploadOnly = await invoke("lego_upload_program", {
            filePath: programUri.fsPath, slot: 6, waitForCompletion: true, timeoutSeconds: 0,
        });
        assert.strictEqual("completion" in uploadOnly, false);
        assert.deepStrictEqual(client.requests, [{ slot: 5, stop: false }]);
    });

    test("Rejects invalid slots, non-workspace paths and disconnected hubs without uploading", async () => {
        for (const slot of [-1, 20, 1.5, NaN]) {
            await assert.rejects(invoke("lego_start_program", { slot }), /slot must/);
        }
        await assert.rejects(invoke("lego_upload_program", { filePath: "relative.py", slot: 5 }));
        await assert.rejects(invoke("lego_upload_program", { filePath: programUri.with({ path: "/outside.py" }).toString(), slot: 5 }), /workspace/);
        await client.disconnect();
        await assert.rejects(invoke("lego_upload_program", { filePath: programUri.fsPath, slot: 5 }), /disconnected/);
        assert.strictEqual(uploaded, undefined);
        assert.deepStrictEqual(client.requests, []);
    });

    test("Reads plain logs without a connected hub and explicitly reports truncated snapshots", async () => {
        getLogger().log("\u001b[31mhello robot\u001b[0m\r\n");
        await client.disconnect();
        const snapshot = await invoke("lego_read_logs", { maxCharacters: 5 });
        assert.deepStrictEqual(snapshot, { text: "bot\r\n", truncated: true, connected: false });
        getLogger().clear();
        assert.deepStrictEqual(await invoke("lego_read_logs", {}), { text: "", truncated: false, connected: false });
    });

    test("Confirmation describes overwrite and motor motion without performing any operation", async () => {
        const prepared = await getTool("lego_upload_program").prepareInvocation?.({
            input: { filePath: programUri.fsPath, slot: 5, run: true },
        }, cancellation.token);
        assert.ok(prepared?.confirmationMessages);
        assert.ok(String(prepared.confirmationMessages.message).includes("removes all existing files"));
        assert.ok(String(prepared.confirmationMessages.message).includes("may move motors"));
        assert.strictEqual(uploaded, undefined);
        assert.deepStrictEqual(client.requests, []);
    });

    test("Telemetry returns a fresh typed sample, preserving zero, false and negative values", async () => {
        const stale = new DeviceNotificationMessage();
        stale.devices = [{ type: "battery", level: 99 }];
        client.onDeviceNotification.fire(stale);
        const sample = new DeviceNotificationMessage();
        sample.devices = [
            { type: "battery", level: 0 },
            { type: "imu", hubFaceUp: 1, yawFace: 0, yaw: -100, pitch: 0, roll: 20, accX: 0, accY: -1, accZ: 1000, gyroX: 0, gyroY: 0, gyroZ: -2 },
            { type: "motor", port: 0, deviceType: 48, absPosition: -10, power: 0, speed: 0, position: -100 },
            { type: "force", port: 1, value: 0, pressed: false },
            { type: "distance", port: 2, distance: -1 },
            { type: "color", port: 3, color: -1, colorName: "unknown", reflected: 0, red: 0, green: 0, blue: 0 },
            { type: "matrix5x5", pixels: Array(25).fill(0) },
            { type: "matrix3x3", port: 4, pixels: Array(9).fill(0) },
        ];
        client.requestTelemetry = async () => {
            client.onDeviceNotification.fire(sample);
            return new DeviceNotificationResponseMessage();
        };
        const before = Date.now();
        const snapshot = await invoke("lego_get_telemetry", {});
        assert.ok("receivedAt" in snapshot && typeof snapshot.receivedAt === "string");
        const received = Date.parse(snapshot.receivedAt);
        assert.ok(received >= before && received <= Date.now());
        assert.deepStrictEqual(snapshot, {
            connected: true,
            hubName: null,
            transport: "usb",
            receivedAt: snapshot.receivedAt,
            devices: sample.devices,
        });
        assert.strictEqual(client.telemetryRequestCount, 1);
        assert.deepStrictEqual(client.requests, []);
    });

    test("Telemetry request rejection and disconnected hubs fail without returning cached readings", async () => {
        client.requestTelemetry = async () => { throw new Error("Failed to start device notifications"); };
        await assert.rejects(invoke("lego_get_telemetry", {}), /Failed to start device notifications/);
        await client.disconnect();
        await assert.rejects(invoke("lego_get_telemetry", {}), /disconnected/);
        assert.strictEqual(client.telemetryRequestCount, 1);
    });

    test("Disconnect and chat cancellation settle telemetry waits immediately", async () => {
        let entered!: () => void;
        let requested = new Promise<void>(resolve => { entered = resolve; });
        client.requestTelemetry = async () => {
            entered();
            return new DeviceNotificationResponseMessage();
        };
        const disconnected = invoke("lego_get_telemetry", {});
        await requested;
        const rejected = assert.rejects(disconnected, /disconnected/);
        await client.disconnect();
        await rejected;

        initClient(ChatTestClient);
        const initialized = getClient();
        assert.ok(initialized instanceof ChatTestClient);
        client = initialized;
        requested = new Promise<void>(resolve => { entered = resolve; });
        client.requestTelemetry = async () => {
            entered();
            return new DeviceNotificationResponseMessage();
        };
        const cancelled = invoke("lego_get_telemetry", {});
        await requested;
        const cancelRejected = assert.rejects(cancelled, error => error instanceof vscode.CancellationError);
        cancellation.cancel();
        await cancelRejected;
        assert.strictEqual(client.isConnectedIn, true);
    });

    test("Telemetry times out after 10 seconds when notifications never arrive", async () => {
        const before = Date.now();
        await assert.rejects(invoke("lego_get_telemetry", {}), /No telemetry received.*10 seconds/);
        assert.ok(Date.now() - before >= 10000);
    }).timeout(15000);

    test("BLE scan returns usable IDs and validates scan duration", async () => {
        assert.deepStrictEqual(await invoke("lego_scan_ble", {}), {
            hubs: [{ name: "My Hub", connectionId: "ble-id", description: null }],
        });

        assert.strictEqual(scanDuration, 5000);
        await invoke("lego_scan_ble", { durationSeconds: 30 });
        assert.strictEqual(scanDuration, 30000);
        for (const durationSeconds of [0, 31, 1.5]) {
            await assert.rejects(invoke("lego_scan_ble", { durationSeconds }), /durationSeconds/);
        }
    });

    test("BLE and USB connect return established transport and reject replacing a connected hub", async () => {
        await assert.rejects(invoke("lego_connect_ble", { connectionId: "ble-id" }), /already connected/);
        client.connected = false;
        await assert.rejects(invoke("lego_connect_ble", {}), /connectionId/);
        assert.deepStrictEqual(await invoke("lego_connect_ble", { connectionId: "ble-id" }), {
            connected: true, transport: "bluetooth", hubName: null,
        });
        await invoke("lego_disconnect", {});
        assert.deepStrictEqual(await invoke("lego_connect_usb", { connectionId: "serial-id" }), {
            connected: true, transport: "usb", hubName: null,
        });
        await invoke("lego_disconnect", {});
        await invoke("lego_connect_usb", {});
        assert.deepStrictEqual(connectionCalls, [
            { transport: "bluetooth", id: "ble-id" },
            { transport: "usb", id: "serial-id" },
            { transport: "usb", id: undefined },
        ]);
    });

    test("USB scan returns serial-number IDs without connecting or starting a program", async () => {
        assert.deepStrictEqual(await invoke("lego_scan_usb", {}), {
            hubs: [{ name: "COM3", connectionId: "serial-id", description: "serial-id" }],
        });
        assert.deepStrictEqual(connectionCalls, []);
        assert.deepStrictEqual(client.requests, []);
    });

    test("Disconnect waits for the close event and does not send a program stop", async () => {
        const originalDisconnect = client.disconnect;
        let close!: () => void;
        client.disconnect = async () => {
            close = () => {
                client.connected = false;
                client.onClosed.fire();
            };
        };
        try {
            let settled = false;
            const disconnect = invoke("lego_disconnect", {}).then(output => {
                settled = true;
                return output;
            });
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.strictEqual(settled, false);
            close();
            assert.deepStrictEqual(await disconnect, { connected: false, disconnected: true });
            assert.deepStrictEqual(await invoke("lego_disconnect", {}), { connected: false, disconnected: false });
            assert.deepStrictEqual(client.requests, []);
        }
        finally {
            client.disconnect = originalDisconnect;
        }
    });

    test("Cancelled connection tools do not call connection services", async () => {
        client.connected = false;
        cancellation.cancel();
        for (const name of ["lego_scan_ble", "lego_scan_usb", "lego_connect_ble", "lego_connect_usb", "lego_disconnect"]) {
            await assert.rejects(invoke(name, { connectionId: "id" }), error => error instanceof vscode.CancellationError);
        }
        assert.deepStrictEqual(connectionCalls, []);
        assert.strictEqual(scanDuration, undefined);
    });

    test("Unsupported web scans and failed connection services surface errors instead of success", async () => {
        registerChatConnectionTools({ subscriptions }, {
            connectUsb: async () => { throw new Error("Device chooser cancelled"); },
        });
        client.connected = false;
        await assert.rejects(invoke("lego_scan_usb", {}), /desktop VS Code/);
        await assert.rejects(invoke("lego_scan_ble", {}), /desktop VS Code/);
        await assert.rejects(invoke("lego_connect_ble", { connectionId: "ble-id" }), /desktop VS Code/);
        await assert.rejects(invoke("lego_connect_usb", {}), /Device chooser cancelled/);

        registerChatConnectionTools({ subscriptions }, {
            connectUsb: async () => { /* service did not establish a connection */ },
        });
        await assert.rejects(invoke("lego_connect_usb", {}), /not established/);
        assert.strictEqual(client.connected, false);
    });
});
