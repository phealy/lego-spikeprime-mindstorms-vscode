import * as mpy from "@pybricks/mpy-cross-v6";

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as shellQuote from "shell-quote";
import { v7 } from "uuid";
import * as vscode from "vscode";

import { BaseClient, HubQuickPickItem } from "./clients/base-client";
import { BleClient } from "./clients/ble-client";
import { UsbClient } from "./clients/usb-client";
import {
    configureRawMessageLogging,
    getClient,
    getLogger,
    getProgramInfo,
    initClient,
    initHubStatusBarItems,
    onDeactivate,
    onHubConnected,
    registerSharedCommands,
    startProgramInSlot,
    uploadProgramToHub,
} from "./shared-extension";
import { Command, setTimeoutAsync } from "./utils";
import { LiveDataViewProvider } from "./views/live-telemetry-provider";

let mpyWasm: Uint8Array | undefined;
const LAST_CONNECTION_KEY = "lastHubConnection";
const supportedClients: vscode.QuickPickItem[] = [
    { label: Client.Ble },
    { label: Client.Usb },
];

const enum Client {
    Ble = "Bluetooth",
    Usb = "USB",
}

interface StoredConnection {
    client: Client;
    connectionId: string;
}

interface CombinedHubQuickPickItem extends HubQuickPickItem {
    clientType: Client;
}

export function activate(context: vscode.ExtensionContext) {
    // HACK: This is a workaround for https://github.com/pybricks/support/issues/2185
    const wasmFilePath = path.join(__dirname, "mpy-cross-v6.wasm");
    mpyWasm = fs.readFileSync(wasmFilePath);

    initHubStatusBarItems(context);
    configureRawMessageLogging(context);

    registerSharedCommands(context);

    const provider = new LiveDataViewProvider(getClient);
    let connectionAttemptInProgress = false;

    const connectToHubCommand = vscode.commands.registerCommand(
        Command.ConnectToHub,
        async () => {
            if (connectionAttemptInProgress) {
                return;
            }

            connectionAttemptInProgress = true;
            try {
                const searchBoth = vscode.workspace.getConfiguration().get<boolean>(
                    "legoSpikePrimeMindstorms.automaticallySearchForBothBleAndUsbHubs",
                    true,
                );
                let clientType: Client;
                let selection: HubQuickPickItem | undefined;

                if (searchBoth) {
                    const combinedSelection = await showCombinedHubQuickPick();
                    if (!combinedSelection) {
                        return;
                    }

                    clientType = combinedSelection.clientType;
                    selection = combinedSelection;
                    initializeClient(clientType);
                }
                else {
                    const clientSelection = await vscode.window.showQuickPick(
                        supportedClients,
                        { canPickMany: false },
                    );
                    if (!clientSelection) {
                        return;
                    }

                    clientType = clientSelection.label as Client;
                    initializeClient(clientType);
                    selection = await showHubQuickPick(getClient()!);
                }

                if (!selection) {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Connecting to Hub...",
                    },
                    () => getClient()!.connect(selection.connectionId),
                );

                await finishConnection(provider);
                await context.globalState.update(LAST_CONNECTION_KEY, {
                    client: clientType,
                    connectionId: selection.connectionId,
                } satisfies StoredConnection);
            }
            catch (e) {
                console.error(e);
                vscode.window.showErrorMessage(
                    "Connecting to Hub Failed!" +
                        (e instanceof Error ? ` ${e.message}` : ""),
                );
            }
            finally {
                connectionAttemptInProgress = false;
            }
        },
    );

    const uploadProgramCommand = vscode.commands.registerCommand(
        Command.UploadProgram,
        async () => {
            if (!getClient()?.isConnectedIn) {
                vscode.window.showErrorMessage(
                    "LEGO Hub not connected! Please connect first!",
                );
                return;
            }

            try {
                const programInfo = await getProgramInfo();
                if (!programInfo) {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: programInfo.isAutostartIn
                            ? "Uploading and running program..."
                            : `Uploading Program to Hub (Slot #${programInfo.slotId})...`,
                    },
                    async (progress) => {
                        await performUploadProgram(programInfo.slotId, progress);
                        if (programInfo.isAutostartIn) {
                            await setTimeoutAsync(() => { /* noop */ }, 250);
                            await startProgramInSlot(programInfo.slotId, false);
                        }
                    },
                );

                if (!programInfo.isAutostartIn) {
                    vscode.window.showInformationMessage("Program uploaded!");
                }
            }
            catch (e) {
                console.error(e);
                vscode.window.showErrorMessage(
                    "Program Upload Failed!" +
                        (e instanceof Error ? ` ${e.message}` : ""),
                );
            }
        },
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "lego-spikeprime-mindstorms-vscode.showLiveTelemetry",
            async () => {
                await vscode.commands.executeCommand(
                    "workbench.view.extension.legoRobotPanel",
                );

                await vscode.commands.executeCommand("legoLiveView.focus");
            },
        ),
    );

    context.subscriptions.push(
        connectToHubCommand,
        uploadProgramCommand,
        vscode.window.registerWebviewViewProvider(
            LiveDataViewProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    if (vscode.workspace.getConfiguration().get<boolean>(
        "legoSpikePrimeMindstorms.connectToLastHubOnStartup",
        true,
    )) {
        const storedConnection = context.globalState.get<StoredConnection>(LAST_CONNECTION_KEY);
        if (storedConnection) {
            connectionAttemptInProgress = true;
            void reconnectToLastHub(storedConnection, provider).finally(() => {
                connectionAttemptInProgress = false;
            });
        }
    }
}

function initializeClient(clientType: Client): void {
    switch (clientType) {
        case Client.Ble:
            initClient(BleClient);
            break;

        case Client.Usb:
            initClient(UsbClient);
            break;

        default:
            throw new Error("Unsupported client");
    }
}

async function finishConnection(provider: LiveDataViewProvider): Promise<void> {
    const connectedClient = getClient()!;
    connectedClient.onDeviceNotification.event((msg) => {
        provider.updateTelemetry(msg.devices);
    });
    connectedClient.onClosed.event(() => {
        provider.setClientStateChanged();
    });

    await onHubConnected();
    await connectedClient.startDeviceNotifications();
    provider.setClientStateChanged();
}

async function reconnectToLastHub(
    storedConnection: StoredConnection,
    provider: LiveDataViewProvider,
): Promise<void> {
    try {
        initializeClient(storedConnection.client);
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Reconnecting to LEGO Hub...",
            },
            () => getClient()!.reconnect(storedConnection.connectionId),
        );
        await finishConnection(provider);
    }
    catch (error) {
        getLogger().error(
            "Unable to reconnect to the last LEGO Hub: " +
            (error instanceof Error ? error.message : error),
        );
    }
}

async function showCombinedHubQuickPick(): Promise<CombinedHubQuickPickItem | undefined> {
    const input = vscode.window.createQuickPick<CombinedHubQuickPickItem>();
    const cancellation = new vscode.CancellationTokenSource();
    const items = new Map<string, CombinedHubQuickPickItem>();
    input.placeholder = "Searching for Bluetooth and USB hubs...";
    input.busy = true;

    const publishItems = () => {
        input.items = [...items.values()];
        input.busy = items.size === 0;
    };
    const updateItems = (clientType: Client, discoveredItems: readonly HubQuickPickItem[]) => {
        for (const item of discoveredItems) {
            items.set(`${clientType}:${item.connectionId}`, {
                ...item,
                description: item.description
                    ? `${clientType} · ${item.description}`
                    : clientType,
                clientType,
            });
        }
        publishItems();
    };
    const selectionPromise = new Promise<CombinedHubQuickPickItem | undefined>((resolve) => {
        input.onDidAccept(() => {
            resolve(input.selectedItems[0]);
            input.hide();
        });
        input.onDidHide(() => resolve(undefined));
    });
    const clients: Array<{ type: Client, client: BaseClient }> = [
        { type: Client.Ble, client: new BleClient(getLogger()) },
        { type: Client.Usb, client: new UsbClient(getLogger()) },
    ];
    const listPromises = clients.map(({ type, client }) => client
        .list(discoveredItems => updateItems(type, discoveredItems), cancellation.token)
        .then(finalItems => updateItems(type, finalItems))
        .catch((error) => {
            getLogger().error(`Unable to search for ${type} hubs: ${error}`);
        }));

    input.show();
    try {
        return await selectionPromise;
    }
    finally {
        cancellation.cancel();
        await Promise.allSettled(listPromises);
        cancellation.dispose();
        input.dispose();
    }
}

async function showHubQuickPick(client: BaseClient): Promise<HubQuickPickItem | undefined> {
    const input = vscode.window.createQuickPick<HubQuickPickItem>();
    const cancellation = new vscode.CancellationTokenSource();
    input.placeholder = "Searching for hubs...";
    input.busy = true;

    const selectionPromise = new Promise<HubQuickPickItem | undefined>((resolve) => {
        input.onDidAccept(() => {
            resolve(input.selectedItems[0]);
            input.hide();
        });
        input.onDidHide(() => resolve(undefined));
    });
    const updateItems = (items: readonly HubQuickPickItem[]) => {
        input.items = items;
        input.busy = items.length === 0;
    };
    const listPromise = client.list(updateItems, cancellation.token).then(updateItems);

    input.show();
    try {
        return await Promise.race([
            selectionPromise,
            listPromise.then(() => selectionPromise),
        ]);
    }
    finally {
        cancellation.cancel();
        await listPromise;
        cancellation.dispose();
        input.dispose();
    }
}

// this method is called when your extension is deactivated
export async function deactivate() {
    await onDeactivate();
}

async function performUploadProgram(
    slotId: number,
    progress?: vscode.Progress<{ increment: number }>,
) {
    const currentlyOpenTabFileUri =
        vscode.window.activeTextEditor?.document.uri;
    const currentlyOpenTabFilePath =
        vscode.window.activeTextEditor?.document.fileName;
    const config = vscode.workspace.getConfiguration();

    if (currentlyOpenTabFilePath && currentlyOpenTabFileUri) {
        const logger = getLogger();
        const currentlyOpenTabFileName = path
            .basename(currentlyOpenTabFilePath)
            .replace(path.extname(currentlyOpenTabFilePath), "");
        const assembledFile = assembleFile(currentlyOpenTabFileUri.fsPath);
        const isSaveFileToUploadIn = config.get<boolean>(
            "legoSpikePrimeMindstorms.saveFileToUpload",
        );
        const customPreprocessorPath = config.get<string>(
            "legoSpikePrimeMindstorms.customPrepocessorPath",
        );
        let assembledFilePath = isSaveFileToUploadIn
            ? path.join(
                path.dirname(currentlyOpenTabFilePath),
                `${currentlyOpenTabFileName}.assembled.py`,
            )
            : path.join(os.tmpdir(), `${v7()}.py`);

        fs.writeFileSync(assembledFilePath, assembledFile!, "utf8");

        if (customPreprocessorPath) {
            const preprocessedFilePath = await executeCustomPreprocessor(
                customPreprocessorPath,
                assembledFilePath,
            );

            if (preprocessedFilePath !== assembledFilePath) {
                if (!isSaveFileToUploadIn) {
                    // Remove previous temp assembled file
                    try {
                        fs.rmSync(assembledFilePath);
                    }
                    catch {
                        // Ignore error if error occurs while deleting the file
                    }
                }

                assembledFilePath = preprocessedFilePath;
            }
        }

        let compileResult: mpy.CompileResult | undefined;
        if (config.get("legoSpikePrimeMindstorms.compileBeforeUpload")) {
            compileResult = await mpy.compile(
                path.basename(assembledFilePath),
                fs.readFileSync(assembledFilePath).toString("utf-8"),
                [],
                undefined,
                mpyWasm,
            );

            if (compileResult?.status !== 0) {
                logger?.error(compileResult.err.join("\r\n"));
                logger?.error("\r\n");
                throw new Error("Compilation Failed!");
            }
        }

        const data = compileResult?.mpy ?? fs.readFileSync(assembledFilePath);
        await uploadProgramToHub(data, slotId, !!compileResult?.mpy, progress);

        // Remove temp file if needed
        if (customPreprocessorPath || !isSaveFileToUploadIn) {
            try {
                fs.rmSync(assembledFilePath);
            }
            catch {
                // Ignore error if error occurs while deleting the file
            }
        }
    }
}

/**
 * The provided file should be assembled by replacing the import statements with the content of the imported local python file.
 *
 * @param filePath The path to the file to be assembled.
 * @returns Uint8Array containing the assembled file content.
 */
function assembleFile(filePath: string): Uint8Array | undefined {
    try {
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const assembledLines: string[] = fileContent.split("\n");
        const includedFiles: string[] = [];

        const pattern = /^from\s+([\w\d_]+)\s+import\s+\*/;

        let startLine = 0;

        for (let index = startLine; index < assembledLines.length; index++) {
            const line = assembledLines[index];

            const match = line.match(pattern);

            if (!match?.[1]) continue;

            let includePath = match[1] + ".py";
            includePath = path.resolve(path.dirname(filePath), includePath);
            if (!fs.existsSync(includePath)) {
                vscode.window.showWarningMessage(
                    "File: " + includePath + " not found",
                );
                continue;
            }
            assembledLines.splice(index, 1);
            if (
                includedFiles.some(
                    (includedFile) => includedFile === includePath,
                )
            )
                continue;
            try {
                startLine = index;

                includedFiles.push(includePath);
                const includedContent = fs.readFileSync(includePath, "utf-8");
                const includedContentSplitted = includedContent.split("\n");
                assembledLines.splice(index, 0, ...includedContentSplitted);
                index--;
            }
            catch (includeError) {
                vscode.window.showErrorMessage(
                    "Error reading included file:" + includeError,
                );
            }
        }

        const extendedContent = assembledLines.join("\n");
        const extendedBuffer = Buffer.from(extendedContent, "utf-8");

        return new Uint8Array(extendedBuffer);
    }
    catch (error) {
        console.error("Error extending file:", error);
        vscode.window.showErrorMessage("Error extending file: " + error);
        return undefined;
    }
}

/**
 * Executes a custom preprocessor script on a given file and returns the path to the preprocessed output file.
 *
 * This function spawns a child process to run the specified custom preprocessor, passing the input file via stdin
 * and writing the output to a temporary file. If the preprocessor exits with a non-zero code, the promise is rejected.
 * Any errors from the preprocessor's stderr are logged and shown to the user via VS Code notifications.
 *
 * @param customPreprocessorPath - The command line string specifying the path to the custom preprocessor executable, optionally with arguments.
 * @param filePath - The path to the input file to be preprocessed.
 * @returns A promise that resolves with the path to the preprocessed output file, or rejects if the preprocessor fails.
 */
function executeCustomPreprocessor(
    customPreprocessorPath: string,
    filePath: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!customPreprocessorPath) {
            resolve(filePath);
            return;
        }

        const preprocessedFilePath = path.join(os.tmpdir(), `${v7()}.py`);
        const [executable, ...args] = shellQuote.parse(customPreprocessorPath);
        const child = cp.spawn(
            executable.toString(),
            args.map((arg) => arg.toString()),
            {
                stdio: [
                    fs.openSync(filePath, "r"), // stdin
                    fs.openSync(preprocessedFilePath, "w"), // stdout
                    "pipe", // stderr
                ],
            },
        );

        child.stderr?.on("data", (data) => {
            const message = `Custom preprocessor error: ${data.toString().trimEnd()}\n`;
            console.error(message);
            vscode.window.showErrorMessage(
                message,
            );
        });
        child.on("close", (code) => {
            if (code !== 0) {
                console.error(`Custom preprocessor exited with code ${code}`);
                vscode.window.showErrorMessage(
                    `Custom preprocessor exited with code ${code}`,
                );
                reject(
                    new Error(`Custom preprocessor exited with code ${code}`),
                );
            }
            else {
                resolve(preprocessedFilePath);
            }
        });
    });
}
