import * as mpy from "@pybricks/mpy-cross-v6";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { v7 } from "uuid";
import * as vscode from "vscode";

import { BaseClient, HubQuickPickItem } from "./clients/base-client";
import { BleClient } from "./clients/ble-client";
import { UsbClient } from "./clients/usb-client";
import { executeCustomPreprocessor } from "./custom-preprocessor";
import { findFileInParentDirectories } from "./file-search";
import { registerHubOS3Stubs } from "./pylance-stubs";
import {
    clearProgramSlot,
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
    uploadFileToHub,
    uploadProgramToHub,
    withUploadProgress,
} from "./shared-extension";
import {
    Command,
    formatProgramLog,
    getImportedModuleNames,
    hasLegoProgramHeader,
    parseLegoProgramHeader,
    setTimeoutAsync,
    validateLegoProgramManifest,
} from "./utils";
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

interface LegoProgramFile {
    filePath: string;
    relativePath: string;
    slotId: number;
    includeFileNames: string[];
}

export function activate(context: vscode.ExtensionContext) {
    // HACK: This is a workaround for https://github.com/pybricks/support/issues/2185
    const wasmFilePath = path.join(__dirname, "mpy-cross-v6.wasm");
    mpyWasm = fs.readFileSync(wasmFilePath);

    initHubStatusBarItems(context);
    configureRawMessageLogging(context);
    registerHubOS3Stubs(context);

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

                await withUploadProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: programInfo.isAutostartIn
                            ? "Uploading and running program..."
                            : `Uploading Program to Hub (Slot #${programInfo.slotId})...`,
                    },
                    async (progress) => {
                        await performUploadProgram(
                            vscode.window.activeTextEditor!.document.fileName,
                            programInfo.slotId,
                            programInfo.includeFileNames,
                            progress,
                        );
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

    const uploadAllProgramsCommand = vscode.commands.registerCommand(
        Command.UploadAllPrograms,
        async (resourceUri?: vscode.Uri) => {
            if (!getClient()?.isConnectedIn) {
                vscode.window.showErrorMessage(
                    "LEGO Hub not connected! Please connect first!",
                );
                return;
            }

            try {
                const resourcePath = resourceUri?.fsPath
                    || vscode.window.activeTextEditor?.document.uri.fsPath;
                if (!resourcePath || !fs.existsSync(resourcePath)) {
                    throw new Error("Save the active Python file before uploading its folder.");
                }
                const folderPath = fs.statSync(resourcePath).isDirectory()
                    ? resourcePath
                    : path.dirname(resourcePath);
                const programs = findLegoPrograms(folderPath);
                validateLegoProgramManifest(programs.map(program => ({
                    fileName: program.relativePath,
                    slotId: program.slotId,
                })));

                for (const program of programs) {
                    loadIncludeFiles(program.filePath, program.includeFileNames);
                }

                if (programs.length === 0) {
                    vscode.window.showInformationMessage(
                        "No Python files with a LEGO header were found.",
                    );
                    return;
                }

                programs.sort((left, right) => left.slotId - right.slotId);
                const folderName = path.basename(folderPath);
                getLogger().info(
                    `Upload All: starting ${programs.length} programs from ${folderName}.\r\n`,
                );
                await withUploadProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Uploading ${programs.length} LEGO programs...`,
                    },
                    async (progress) => {
                        const increment = 100 / programs.length;
                        for (const program of programs) {
                            progress.report({
                                message: `${program.relativePath} (slot ${program.slotId})`,
                            });
                            await performUploadProgram(
                                program.filePath,
                                program.slotId,
                                program.includeFileNames,
                            );
                            progress.report({ increment });
                        }
                    },
                );
                getLogger().info(
                    `Upload All: finished ${programs.length} programs from ${folderName}.\r\n`,
                );

                vscode.window.showInformationMessage(
                    `${programs.length} LEGO programs uploaded!`,
                );
            }
            catch (e) {
                console.error(e);
                vscode.window.showErrorMessage(
                    "Upload All Failed!" +
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
                    "workbench.view.extension.legoHubPanel",
                );

                await vscode.commands.executeCommand("legoLiveView.focus");
            },
        ),
        vscode.commands.registerCommand(
            "lego-spikeprime-mindstorms-vscode.openLiveTelemetryPanel",
            () => provider.showPanel(),
        ),
    );

    context.subscriptions.push(
        connectToHubCommand,
        uploadAllProgramsCommand,
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
    programPath: string,
    slotId: number,
    includeFileNames: string[],
    progress?: vscode.Progress<{ increment: number }>,
) {
    const config = vscode.workspace.getConfiguration();

    if (programPath) {
        const logger = getLogger();
        const currentlyOpenTabFileName = path
            .basename(programPath)
            .replace(path.extname(programPath), "");
        const includeFiles = loadIncludeFiles(
            programPath,
            includeFileNames,
        );
        const importedFiles = loadImportedFiles(
            programPath,
            includeFiles,
        );
        const sourceFile = fs.readFileSync(programPath);
        const isSaveFileToUploadIn = config.get<boolean>(
            "legoSpikePrimeMindstorms.saveFileToUpload",
        );
        const customPreprocessorPath = config.get<string>(
            "legoSpikePrimeMindstorms.customPrepocessorPath",
        );
        const compileBeforeUpload = config.get<boolean>(
            "legoSpikePrimeMindstorms.compileBeforeUpload",
        ) ?? false;
        let assembledFilePath = isSaveFileToUploadIn
            ? path.join(
                path.dirname(programPath),
                `${currentlyOpenTabFileName}.assembled.py`,
            )
            : path.join(os.tmpdir(), `${v7()}.py`);

        fs.writeFileSync(assembledFilePath, sourceFile);

        if (customPreprocessorPath) {
            const preprocessedFilePath = await executeCustomPreprocessor(
                customPreprocessorPath,
                assembledFilePath,
                message => {
                    console.error(message);
                    vscode.window.showErrorMessage(message);
                },
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
        if (compileBeforeUpload) {
            compileResult = await mpy.compile(
                path.basename(assembledFilePath),
                fs.readFileSync(assembledFilePath).toString("utf-8"),
                [],
                undefined,
                mpyWasm,
            );

            if (compileResult?.status !== 0) {
                logger?.error(formatProgramLog(
                    slotId,
                    `compilation failed for ${path.basename(programPath)}:\r\n`,
                ));
                logger?.error(
                    compileResult.err
                        .map(error => formatProgramLog(slotId, error))
                        .join("\r\n") + "\r\n",
                );
                throw new Error("Compilation Failed!");
            }
        }

        const data = compileResult?.mpy ?? fs.readFileSync(assembledFilePath);
        const auxiliaryFiles = await prepareAuxiliaryFiles(
            [...includeFiles, ...importedFiles],
            compileBeforeUpload,
            slotId,
        );
        await clearProgramSlot(slotId);
        for (const auxiliaryFile of auxiliaryFiles) {
            await uploadFileToHub(
                auxiliaryFile.data,
                auxiliaryFile.name,
                slotId,
                undefined,
                auxiliaryFile.sourceName,
            );
        }
        await uploadProgramToHub(
            data,
            path.basename(programPath),
            slotId,
            !!compileResult?.mpy,
            progress,
        );

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

async function prepareAuxiliaryFiles(
    files: Array<{ name: string, data: Uint8Array }>,
    compileBeforeUpload: boolean,
    slotId: number,
): Promise<Array<{ name: string, sourceName: string, data: Uint8Array }>> {
    const logger = getLogger();
    const preparedFiles: Array<{ name: string, sourceName: string, data: Uint8Array }> = [];

    for (const file of files) {
        if (!compileBeforeUpload || path.extname(file.name).toLowerCase() !== ".py") {
            preparedFiles.push({ ...file, sourceName: file.name });
            continue;
        }

        const compileResult = await mpy.compile(
            file.name,
            new TextDecoder().decode(file.data),
            [],
            undefined,
            mpyWasm,
        );
        if (compileResult.status !== 0 || !compileResult.mpy) {
            logger?.error(formatProgramLog(
                slotId,
                `compilation failed for ${file.name}:\r\n`,
            ));
            logger?.error(
                compileResult.err
                    .map(error => formatProgramLog(slotId, error))
                    .join("\r\n") + "\r\n",
            );
            throw new Error(`Compilation failed for ${file.name}`);
        }

        const name = file.name.replace(/\.py$/i, ".mpy");
        if (new TextEncoder().encode(name).length > 31) {
            throw new Error(`Compiled file name is too long: ${name}`);
        }
        preparedFiles.push({ name, sourceName: file.name, data: compileResult.mpy });
    }

    return preparedFiles;
}

function findLegoPrograms(folderPath: string): LegoProgramFile[] {
    const programs: LegoProgramFile[] = [];
    const pendingDirectories = [folderPath];

    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop()!;
        const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
            }
            else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".py") {
                const [firstLine = ""] = fs.readFileSync(entryPath, "utf8").split(/\r?\n/, 1);
                if (!hasLegoProgramHeader(firstLine)) {
                    continue;
                }

                const header = parseLegoProgramHeader(firstLine);
                programs.push({
                    filePath: entryPath,
                    relativePath: path.relative(folderPath, entryPath)
                        .split(path.sep).join("/"),
                    slotId: header.slotId,
                    includeFileNames: header.includeFileNames,
                });
            }
        }
    }

    return programs;
}

function loadIncludeFiles(
    programPath: string,
    includeFileNames: string[],
): Array<{ name: string, path: string, data: Uint8Array }> {
    const programDirectory = path.dirname(programPath);
    const projectDirectory = vscode.workspace
        .getWorkspaceFolder(vscode.Uri.file(programPath))?.uri.fsPath
        ?? programDirectory;

    return includeFileNames.map((name) => {
        if (path.basename(name) !== name || name === "." || name === "..") {
            throw new Error(`Included file must be a file name: ${name}`);
        }
        if (new TextEncoder().encode(name).length > 31) {
            throw new Error(`Included file name is too long: ${name}`);
        }

        const includePath = findFileInParentDirectories(
            name,
            programDirectory,
            projectDirectory,
        );
        if (!includePath) {
            throw new Error(`Included file not found: ${name}`);
        }

        return { name, path: includePath, data: fs.readFileSync(includePath) };
    });
}

function loadImportedFiles(
    programPath: string,
    includeFiles: Array<{ name: string, path: string, data: Uint8Array }>,
): Array<{ name: string, path: string, data: Uint8Array }> {
    const projectDirectory = vscode.workspace
        .getWorkspaceFolder(vscode.Uri.file(programPath))?.uri.fsPath
        ?? path.dirname(programPath);
    const knownPaths = new Set([
        path.resolve(programPath),
        ...includeFiles.map(file => path.resolve(file.path)),
    ]);
    const pendingPaths = [
        programPath,
        ...includeFiles
            .filter(file => path.extname(file.name).toLowerCase() === ".py")
            .map(file => file.path),
    ];
    const importedFiles: Array<{ name: string, path: string, data: Uint8Array }> = [];

    while (pendingPaths.length > 0) {
        const currentPath = pendingPaths.shift()!;
        const source = fs.readFileSync(currentPath, "utf-8");
        for (const moduleName of getImportedModuleNames(source)) {
            const name = `${moduleName}.py`;
            const importedPath = findFileInParentDirectories(
                name,
                path.dirname(currentPath),
                projectDirectory,
            );
            if (!importedPath || knownPaths.has(importedPath)) {
                continue;
            }
            if (new TextEncoder().encode(name).length > 31) {
                throw new Error(`Imported file name is too long: ${name}`);
            }

            const importedFile = {
                name,
                path: importedPath,
                data: fs.readFileSync(importedPath),
            };
            knownPaths.add(importedPath);
            importedFiles.push(importedFile);
            pendingPaths.push(importedPath);
        }
    }

    return importedFiles;
}
