import * as vscode from "vscode";

import { BaseClient } from "./clients/base-client";
import { HubDisconnectedError, HubOperation } from "./hub-operation";
import { Logger } from "./logger";
import { ProgramRuns } from "./program-runs";
import {
    Command,
    crc32WithAlignment,
    formatProgramLog,
    hasLegoProgramHeader,
    parseLegoProgramHeader,
} from "./utils";

const writeEmitter = new vscode.EventEmitter<string>();
const logger = new Logger(writeEmitter);
export const programRuns = new ProgramRuns(() => logger.readOutput());
let terminal: vscode.Terminal | null;
let hubStatusBarItem: vscode.StatusBarItem | undefined;
let currentStartedProgramSlotId: number | undefined;
let currentStartedProgramResolve: (() => void) | undefined;
let showCurrentProgramProgress = true;
let client: BaseClient | undefined;
let uploadOperation: HubOperation | undefined;
const hubPopups = new Set<() => void>();
const LEGO_PROGRAM_HEADER_CONTEXT = "lego-spikeprime-mindstorms-vscode.hasLegoProgramHeader";

export function configureRawMessageLogging(context: vscode.ExtensionContext): void {
    const enabled = vscode.workspace.getConfiguration(
        "legoSpikePrimeMindstorms",
    ).get<boolean>("logRawMessagesToFile", false);
    if (!enabled) {
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    logger.configureRawMessageLog(
        vscode.Uri.joinPath(context.logUri, `raw-messages-${timestamp}.jsonl`),
    );
}

export function initClient<U extends BaseClient>(clientClass: new (logger: Logger) => U): void {
    const initializedClient = new clientClass(logger);
    programRuns.supersede();
    client = initializedClient;

    initializedClient.onClosed.event(() => {
        if (client !== initializedClient) {
            return;
        }
        for (const close of hubPopups) {
            close();
        }
        currentStartedProgramResolve?.();
        currentStartedProgramSlotId = undefined;
        currentStartedProgramResolve = undefined;
        showCurrentProgramProgress = true;
        if (client === initializedClient) {
            client = undefined;
            uploadOperation = undefined;
            void updateHubStatusBarItem();
        }
    });

    initializedClient.onProgramRunningChanged.event((isRunningIn) => {
        if (client !== initializedClient) {
            return;
        }
        if (isRunningIn && currentStartedProgramSlotId !== undefined && showCurrentProgramProgress && !currentStartedProgramResolve) {
            void vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Running Program #${currentStartedProgramSlotId}...`,
                    cancellable: true,
                },
                (progress, token) => new Promise<void>((resolve, reject) => {
                    const cancellation = token.onCancellationRequested(() => {
                        void terminateCurrentProgram();
                        currentStartedProgramResolve?.();
                    });
                    currentStartedProgramResolve = () => {
                        cancellation.dispose();
                        resolve();
                    };
                }),
            );
        }

        if (!isRunningIn && currentStartedProgramResolve) {
            currentStartedProgramResolve();
            currentStartedProgramResolve = undefined;
        }
        if (!isRunningIn) {
            showCurrentProgramProgress = true;
        }
    });
}

export function getClient(): BaseClient | undefined {
    return client;
}

export function getLogger(): Logger {
    return logger;
}

export function registerSharedCommands(context: vscode.ExtensionContext): void {
    const updateLegoProgramHeaderContext = () => {
        const document = vscode.window.activeTextEditor?.document;
        const hasHeader = document?.languageId === "python"
            && hasLegoProgramHeader(document.lineAt(0).text);
        void vscode.commands.executeCommand(
            "setContext",
            LEGO_PROGRAM_HEADER_CONTEXT,
            hasHeader,
        );
    };
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(
        updateLegoProgramHeaderContext,
    );
    const documentListener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
            updateLegoProgramHeaderContext();
        }
    });
    updateLegoProgramHeaderContext();

    const disconnectFromHubCommand = vscode.commands.registerCommand(Command.DisconnectFromHub, async () => {
        if (!client?.isConnectedIn) {
            return;
        }

        try {
            await withHubOperation(operation => withHubProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Disconnecting from Hub...",
                },
                () => operation.client.disconnect(),
                operation,
            ));
        }
        catch (error) {
            if (!(error instanceof HubDisconnectedError)) {
                logger.error(`Unable to disconnect hub: ${error}`);
                vscode.window.showErrorMessage(`Disconnecting from Hub Failed! ${error}`);
            }
        }
    });

    const setHubNameCommand = vscode.commands.registerCommand(Command.SetHubName, async () => {
        if (!client?.isConnectedIn) {
            vscode.window.showErrorMessage("LEGO Hub not connected! Please connect first!");
            return;
        }

        try {
            await withHubOperation(async operation => {
                const name = await operation.wait(() => vscode.window.showInputBox({
                    prompt: "Enter a new hub name",
                    validateInput: validateHubName,
                }, operation.token));
                if (name === undefined) {
                    return;
                }
                const success = await withHubProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Setting LEGO Hub Name...",
                    },
                    () => operation.client.setHubName(name),
                    operation,
                );

                if (!success) {
                    vscode.window.showErrorMessage("Setting hub name not acknowledged by hub!");
                    return;
                }

                await updateHubStatusBarItem();
                vscode.window.showInformationMessage(`LEGO Hub renamed to "${name}".`);
            });
        }
        catch (e) {
            if (e instanceof HubDisconnectedError) {
                return;
            }
            console.error(e);
            vscode.window.showErrorMessage("Setting Hub Name Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
        }
    });

    const startProgramCommand = vscode.commands.registerCommand("lego-spikeprime-mindstorms-vscode.startProgram", async () => {
        if (!client?.isConnectedIn) {
            vscode.window.showErrorMessage("LEGO Hub not connected! Please connect first!");
            return;
        }

        try {
            await withHubOperation(async operation => {
                const slotId = await promptForSlot(undefined, undefined, operation);
                await startProgramInSlot(slotId, true, operation);
            });
        }
        catch (e) {
            if (e instanceof HubDisconnectedError) {
                return;
            }
            console.error(e);
            vscode.window.showErrorMessage("Starting Program Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
        }
    });

    const terminateProgramCommand = vscode.commands.registerCommand("lego-spikeprime-mindstorms-vscode.terminateProgram", terminateCurrentProgram);

    const showTerminalCommand = vscode.commands.registerCommand("lego-spikeprime-mindstorms-vscode.showTerminal", showTerminal);

    const addFileHeaderCommand = vscode.commands.registerCommand("lego-spikeprime-mindstorms-vscode.addFileHeader", async () => {
        try {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                vscode.window.showErrorMessage("Please open a file");
                return;
            }

            // Prompt for slot
            const slotId = await promptForSlot(1, 2);
            if (isNaN(slotId)) {
                return;
            }

            // Prompt for auto start
            const isAutostart = await new Promise<boolean | undefined>(resolve => {
                const input = vscode.window.createQuickPick();
                const popup = registerHubPopup(() => input.hide());

                input.title = "Autostart";
                input.step = 2;
                input.totalSteps = 2;
                input.placeholder = "Should the program start automatically when uploaded?";
                input.items = [
                    { label: "yes" },
                    { label: "no" },
                ];

                input.onDidAccept(() => {
                    const selectedItem = input.selectedItems[0];
                    resolve(selectedItem.label === "yes");
                    input.hide();
                });
                input.onDidHide(() => {
                    popup.dispose();
                    input.dispose();
                    resolve(undefined);
                });

                input.show();
            });

            if (isAutostart === undefined) {
                return;
            }

            editor.edit((editBuilder) => {
                editBuilder.insert(
                    new vscode.Position(0, 0),
                    `# LEGO slot:${slotId}${(isAutostart ? " autostart" : "")}\n\n`,
                );
            });
        }
        catch (e) {
            console.error(e);
            vscode.window.showErrorMessage("Adding File Header Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
        }
    });

    context.subscriptions.push(
        activeEditorListener,
        documentListener,
        disconnectFromHubCommand,
        setHubNameCommand,
        startProgramCommand,
        terminateProgramCommand,
        showTerminalCommand,
        addFileHeaderCommand,
    );
}

function validateHubName(name: string): string | undefined {
    if (!name) {
        return "Hub name cannot be empty";
    }

    if (new TextEncoder().encode(name).length > 29) {
        return "Hub name must be 29 UTF-8 bytes or fewer";
    }

    return undefined;
}

export function initHubStatusBarItems(context: vscode.ExtensionContext) {
    hubStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    hubStatusBarItem.show();
    updateHubStatusBarItem();

    context.subscriptions.push(hubStatusBarItem);
}

export async function getProgramInfo(operation?: HubOperation): Promise<{
    slotId: number,
    isAutostartIn: boolean,
    includeFileNames: string[],
} | undefined> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showErrorMessage("Please open a file");
        return;
    }

    if (operation) {
        await operation.wait(() => vscode.commands.executeCommand("workbench.action.files.save"));
    }
    else {
        await vscode.commands.executeCommand("workbench.action.files.save");
    }

    const header = editor?.document.lineAt(0).text;
    const { isAutostartIn, includeFileNames, slotId: parsedSlotId } =
        parseLegoProgramHeader(header);
    let slotId = parsedSlotId;

    // Prompt for slot
    if (isNaN(slotId)
        || slotId < 0
        || slotId > 19) {
        slotId = await promptForSlot(undefined, undefined, operation);
        if (isNaN(slotId)) {
            return;
        }
    }

    return { slotId, isAutostartIn, includeFileNames };
}

export async function onHubConnected() {
    await withHubOperation(async operation => {
        try {
            await operation.wait(() => operation.client.loadHubName());
        }
        catch (e) {
            operation.check();
            logger.error("Unable to read hub name: " + (e instanceof Error ? e.message : e));
        }

        operation.check();
        operation.client.logConnected();
        await operation.wait(updateHubStatusBarItem);
        showTerminal();
    });
}

export async function onDeactivate() {
    if (client?.isConnectedIn) {
        await client.disconnect();
    }
    await logger.flushRawMessageLog();
}

export async function uploadProgramToHub(
    data: Uint8Array,
    sourceFileName: string,
    slotId: number,
    isCompiledIn: boolean,
    progress?: vscode.Progress<{ increment: number }>,
    operation?: HubOperation,
) {
    await uploadFileToHub(
        data,
        isCompiledIn ? "program.mpy" : "program.py",
        slotId,
        progress,
        sourceFileName,
        operation,
    );
}

export async function clearProgramSlot(slotId: number, operation?: HubOperation) {
    const success = await (operation
        ? operation.wait(() => operation.client.clearSlot(slotId))
        : getConnectedClient().clearSlot(slotId));
    if (!success) {
        throw new Error(`Failed to clear program slot ${slotId}.`);
    }
}

function getConnectedClient(): BaseClient {
    if (!client?.isConnectedIn) {
        throw new HubDisconnectedError();
    }
    return client;
}

export function registerHubPopup(close: () => void): vscode.Disposable {
    hubPopups.add(close);
    return new vscode.Disposable(() => hubPopups.delete(close));
}

export async function withHubOperation<T>(
    task: (operation: HubOperation) => Promise<T>,
    hub = getConnectedClient(),
    token?: vscode.CancellationToken,
): Promise<T> {
    const operation = new HubOperation(hub, token);
    try {
        return await operation.wait(() => task(operation));
    }
    finally {
        operation.dispose();
    }
}

export async function withHubProgress<T>(
    options: vscode.ProgressOptions,
    task: (progress: vscode.Progress<{ message?: string, increment?: number }>) => Promise<T>,
    operation?: HubOperation,
): Promise<T> {
    if (!operation) {
        return withHubOperation(active => withHubProgress(options, task, active));
    }
    return vscode.window.withProgress(options, progress => operation.wait(() => task(progress)));
}

export async function withUploadProgress(
    options: vscode.ProgressOptions,
    upload: (progress: vscode.Progress<{ message?: string, increment?: number }>, operation: HubOperation) => Promise<void>,
    operation?: HubOperation,
): Promise<void> {
    if (!operation) {
        return withHubOperation(active => withUploadProgress(options, upload, active));
    }
    operation.check();
    if (uploadOperation && !uploadOperation.token.isCancellationRequested) {
        throw new Error("An upload is already in progress. Wait for it to finish before uploading again.");
    }
    uploadOperation = operation;
    try {
        await withHubProgress(options, progress => upload(progress, operation), operation);
    }
    finally {
        if (uploadOperation === operation) {
            uploadOperation = undefined;
        }
    }
}

export async function uploadFileToHub(
    data: Uint8Array,
    fileName: string,
    slotId: number,
    progress?: vscode.Progress<{ increment: number }>,
    displayFileName = fileName,
    operation?: HubOperation,
) {
    const uploadSize = data.length;
    operation?.check();
    const uploadClient = operation?.client ?? client;
    if (!uploadClient?.isConnectedIn) {
        throw new Error("Hub disconnected before file upload.");
    }
    const blockSize = uploadClient.maxChunkSize;
    if (blockSize === undefined || !Number.isInteger(blockSize) || blockSize <= 0) {
        throw new Error(`Invalid hub upload chunk size: ${blockSize}`);
    }

    logger.info(formatProgramLog(slotId, `uploading ${displayFileName}...`));
    const start = () => uploadClient.startFileUpload(fileName, slotId, crc32WithAlignment(data));
    await (operation ? operation.wait(start) : start());

    const increment = (1 / Math.ceil(uploadSize / blockSize)) * 100;
    let runningCrc = 0;

    for (let loop = 0; loop < uploadSize; loop += blockSize) {
        const chunk = data.slice(loop, loop + blockSize);
        runningCrc = crc32WithAlignment(chunk, runningCrc);

        const transfer = () => uploadClient.transferChunk(chunk, runningCrc);
        await (operation ? operation.wait(transfer) : transfer());

        progress?.report({ increment });
    }
    logger.info("done.\r\n");
}

export async function startProgramInSlot(slotId: number, showProgress = true, operation?: HubOperation): Promise<string | undefined> {
    if (isNaN(slotId)) {
        return;
    }

    if (!operation) {
        return withHubOperation(active => startProgramInSlot(slotId, showProgress, active));
    }
    operation.check();
    const runId = programRuns.begin(operation.client, slotId);
    if (vscode.workspace.getConfiguration("legoSpikePrimeMindstorms").get<boolean>("clearTerminalOnExecution", true)) {
        logger.clear();
    }
    logger.info(formatProgramLog(slotId, "starting program.\r\n"));
    const startProgram = () => operation.wait(() => operation.client.startStopProgram(slotId));
    showCurrentProgramProgress = showProgress;
    try {
        const success = showProgress
            ? await withHubProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Starting Program in Slot #${slotId}...`,
                },
                startProgram,
                operation,
            )
            : await startProgram();

        if (!success) {
            throw new Error("Starting program not acknowledged from hub!");
        }
        currentStartedProgramSlotId = slotId;
        return runId;
    }
    catch (error) {
        programRuns.fail(runId, error);
        showCurrentProgramProgress = true;
        throw error;
    }
}

export async function stopProgramInSlot(slotId: number, operation?: HubOperation): Promise<void> {
    if (!operation) {
        return withHubOperation(active => stopProgramInSlot(slotId, active));
    }
    const success = await withHubProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Terminating Running Program...",
        },
        () => operation.client.startStopProgram(slotId, true),
        operation,
    );
    if (!success) {
        throw new Error("Terminating program not acknowledged from hub!");
    }
    if (currentStartedProgramSlotId === slotId) {
        currentStartedProgramSlotId = undefined;
    }
}

async function promptForSlot(currentStep?: number, totalSteps?: number, operation?: HubOperation): Promise<number> {
    operation?.check();
    return new Promise<number>((resolve) => {
        const quickPickSlots: vscode.QuickPickItem[] = [];
        for (let index = 0; index < 20; index++) {
            quickPickSlots.push({
                label: index.toString(),
            });
        }

        const input = vscode.window.createQuickPick();
        const popup = registerHubPopup(() => input.hide());
        const cancellation = operation?.token.onCancellationRequested(() => input.hide());

        input.title = "Program Slot";
        input.step = currentStep;
        input.totalSteps = totalSteps;
        input.placeholder = "Choose program slot";
        input.items = quickPickSlots;

        input.onDidAccept(() => {
            const selectedItem = input.selectedItems[0];
            resolve(+selectedItem.label);
            input.hide();
        });
        input.onDidHide(() => {
            popup.dispose();
            cancellation?.dispose();
            input.dispose();
            resolve(NaN);
        });

        input.show();
    });
}

function showTerminal() {
    if (!terminal) {
        terminal = vscode.window.createTerminal({
            name: "LEGO Hub Terminal",
            pty: {
                onDidWrite: writeEmitter.event,
                open: () => {
                    logger.info("Welcome to the LEGO Hub Log Terminal!\r\n");
                    if (logger.rawMessageLogLocation) {
                        logger.info(`Raw message logging enabled: ${logger.rawMessageLogLocation}\r\n`);
                    }
                },
                close: () => { terminal = null; },
                handleInput: (char: string) => {
                    return;
                },
            },
        });
    }

    terminal.show();
}

async function terminateCurrentProgram() {
    if (!client?.isConnectedIn) {
        vscode.window.showErrorMessage("LEGO Hub not connected! Please connect first!");
        return;
    }

    if (currentStartedProgramSlotId === undefined) {
        vscode.window.showErrorMessage("No program started! Please start a program first!");
        return;
    }

    try {
        const slotId = currentStartedProgramSlotId;
        await stopProgramInSlot(slotId);
    }
    catch (e) {
        if (e instanceof HubDisconnectedError) {
            return;
        }
        console.error(e);
        vscode.window.showErrorMessage("Terminating Program Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
    }
}

async function updateHubStatusBarItem() {
    if (hubStatusBarItem && client?.isConnectedIn) {
        const hubName = client.hubName ? ` ${client.hubName}` : "";
        hubStatusBarItem.text = `$(repl) LEGO Hub:${hubName} Connected (${client.firmwareVersion} / ${client.rpcVersion})`;
        hubStatusBarItem.command = Command.DisconnectFromHub;
    }
    else if (hubStatusBarItem) {
        hubStatusBarItem.text = "$(debug-disconnect) LEGO Hub: Disconnected";
        hubStatusBarItem.command = Command.ConnectToHub;
    }

    vscode.commands.executeCommand("setContext", "lego-spikeprime-mindstorms-vscode.isConnectedIn", client?.isConnectedIn);
}
