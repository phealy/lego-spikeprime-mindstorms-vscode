import * as vscode from "vscode";

import { HubOperation } from "./hub-operation";
import type { TelemetryDevice } from "./messages/device-notification";
import {
    getClient,
    getLogger,
    programRuns,
    startProgramInSlot,
    stopProgramInSlot,
    withHubOperation,
    withUploadProgress,
} from "./shared-extension";
import { parseLegoProgramHeader, setTimeoutAsync } from "./utils";

interface SlotInput {
    slot: number;
}

interface StartInput extends SlotInput {
    waitForCompletion?: boolean;
    timeoutSeconds?: number;
}

interface UploadInput extends StartInput {
    filePath: string;
    run?: boolean;
}

interface LogInput {
    maxCharacters?: number;
}

export type UploadChatProgram = (
    document: vscode.TextDocument,
    slot: number,
    includeFileNames: string[],
    progress: vscode.Progress<{ increment: number }>,
    operation: HubOperation,
) => Promise<void>;

function checkTrusted(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    if (!vscode.workspace.isTrusted) {
        throw new Error("LEGO chat tools require a trusted workspace.");
    }
}

function checkSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot > 19) {
        throw new Error("slot must be an integer from 0 to 19.");
    }
}

function getWaitTimeout(input: StartInput, wait: boolean): number {
    const seconds = input.timeoutSeconds ?? 60;
    if (wait && (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)) {
        throw new Error("timeoutSeconds must be an integer from 1 to 300.");
    }
    return seconds;
}

function getProgramUri(filePath: string): vscode.Uri {
    if (!filePath) {
        throw new Error("Provide an absolute Python file path or workspace URI.");
    }
    const uri = /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(filePath)
        ? vscode.Uri.file(filePath)
        : vscode.Uri.parse(filePath, true);
    if (!vscode.workspace.getWorkspaceFolder(uri) || !uri.path.toLowerCase().endsWith(".py")) {
        throw new Error("The program must be a Python file inside an open workspace folder.");
    }
    return uri;
}

function result(value: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(value)),
    ]);
}

export function registerChatTools(context: Pick<vscode.ExtensionContext, "subscriptions">, upload: UploadChatProgram): void {
    const uploadTool: vscode.LanguageModelTool<UploadInput> = {
        prepareInvocation: (options, token) => {
            checkTrusted(token);
            checkSlot(options.input.slot);
            const uri = getProgramUri(options.input.filePath);
            return {
                invocationMessage: `Uploading ${uri.toString(true)} to LEGO slot ${options.input.slot}`,
                confirmationMessages: {
                    title: options.input.run ? "Upload and start LEGO program" : "Upload LEGO program",
                    message: `Save and upload ${uri.toString(true)} to slot ${options.input.slot}? This removes all existing files in that slot and uses your configured preprocessor and compilation settings.${options.input.run ? " The program will start and may move motors. Ensure the robot is safe to run." : " The program will not be started."}${options.input.run && options.input.waitForCompletion !== false ? " Wait for its end event and share its state and recent logs with Copilot. Cancelling the wait does not stop motors." : ""}`,
                },
            };
        },
        invoke: async (options, token) => {
            checkTrusted(token);
            const input = options.input;
            checkSlot(input.slot);
            const wait = input.run === true && input.waitForCompletion !== false;
            const timeoutSeconds = getWaitTimeout(input, wait);
            const uri = getProgramUri(input.filePath);
            const runId = await withHubOperation(async operation => {
                const document = await operation.wait(() => vscode.workspace.openTextDocument(uri));
                if (document.isDirty && !await operation.wait(() => document.save())) {
                    throw new Error("Unable to save the Python file. Upload cancelled.");
                }
                const header = parseLegoProgramHeader(document.lineAt(0).text);
                let startedRunId: string | undefined;
                await withUploadProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: input.run ? "Uploading and running program..." : `Uploading Program to Hub (Slot #${input.slot})...`,
                    },
                    async progress => {
                        await upload(document, input.slot, header.includeFileNames, progress, operation);
                        if (input.run) {
                            await operation.wait(() => setTimeoutAsync(() => { /* wait for hub upload finalization */ }, 250));
                            startedRunId = await startProgramInSlot(input.slot, false, operation);
                        }
                    },
                    operation,
                );
                return startedRunId;
            }, getClient(), token);
            const completion = wait && runId ? await programRuns.wait(runId, timeoutSeconds, token) : undefined;
            return result({
                uploaded: true,
                started: input.run === true,
                slot: input.slot,
                file: uri.toString(true),
                ...(runId ? { runId } : {}),
                ...(completion ? { completion } : {}),
            });
        },
    };
    const createSlotTool = (stop: boolean): vscode.LanguageModelTool<StartInput> => ({
        prepareInvocation: (options, token) => {
            checkTrusted(token);
            checkSlot(options.input.slot);
            return {
                invocationMessage: `${stop ? "Stopping" : "Starting"} LEGO slot ${options.input.slot}`,
                confirmationMessages: {
                    title: stop ? "Stop LEGO program" : "Start LEGO program",
                    message: `${stop ? "Stop" : "Start"} the program stored in LEGO slot ${options.input.slot}?${stop ? "" : " This may move motors. Ensure the robot is safe to run."}${!stop && options.input.waitForCompletion !== false ? " Wait for its end event and share its state and recent logs with Copilot. Cancelling the wait does not stop motors." : ""}`,
                },
            };
        },
        invoke: async (options, token) => {
            checkTrusted(token);
            checkSlot(options.input.slot);
            const wait = !stop && options.input.waitForCompletion !== false;
            const timeoutSeconds = getWaitTimeout(options.input, wait);
            const runId = await withHubOperation(
                async operation => {
                    if (stop) {
                        await stopProgramInSlot(options.input.slot, operation);
                        return undefined;
                    }
                    return startProgramInSlot(options.input.slot, false, operation);
                },
                getClient(),
                token,
            );
            const completion = wait && runId
                ? await programRuns.wait(runId, timeoutSeconds, token)
                : undefined;
            return result({
                slot: options.input.slot,
                [stop ? "stopped" : "started"]: true,
                ...(runId ? { runId } : {}),
                ...(completion ? { completion } : {}),
            });
        },
    });
    const logTool: vscode.LanguageModelTool<LogInput> = {
        prepareInvocation: (options, token) => {
            checkTrusted(token);
            return {
                invocationMessage: "Reading recent LEGO Hub logs",
                confirmationMessages: {
                    title: "Read LEGO Hub logs",
                    message: "Share recent LEGO Hub program output and extension messages with Copilot Chat?",
                },
            };
        },
        invoke: (options, token) => {
            checkTrusted(token);
            return result({
                ...getLogger().readOutput(options.input.maxCharacters),
                connected: getClient()?.isConnectedIn ?? false,
            });
        },
    };
    const telemetryTool: vscode.LanguageModelTool<object> = {
        prepareInvocation: (options, token) => {
            checkTrusted(token);
            return {
                invocationMessage: "Reading fresh LEGO Hub telemetry",
                confirmationMessages: {
                    title: "Read LEGO Hub telemetry",
                    message: "Share the connected LEGO hub's battery, orientation and device values with Copilot Chat? This does not run a program or move motors.",
                },
            };
        },
        invoke: async (options, token) => {
            checkTrusted(token);
            return withHubOperation(async operation => {
                let subscription: vscode.Disposable | undefined;
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    const nextSample = new Promise<{ receivedAt: string, devices: TelemetryDevice[] }>((resolve, reject) => {
                        subscription = operation.client.onDeviceNotification.event(message => resolve({
                            receivedAt: new Date().toISOString(),
                            devices: message.devices,
                        }));
                        timeout = setTimeout(() => reject(new Error(
                            "No telemetry received from the hub within 10 seconds.",
                        )), 10000);
                    });
                    const [, sample] = await operation.wait(() => Promise.all([
                        operation.client.startDeviceNotifications(),
                        nextSample,
                    ]));
                    return result({
                        connected: true,
                        hubName: operation.client.hubName ?? null,
                        transport: operation.client.transport,
                        ...sample,
                    });
                }
                finally {
                    subscription?.dispose();
                    if (timeout !== undefined) {
                        clearTimeout(timeout);
                    }
                }
            }, getClient(), token);
        },
    };
    const waitTool: vscode.LanguageModelTool<{ runId: string, timeoutSeconds?: number }> = {
        prepareInvocation: (options, token) => {
            checkTrusted(token);
            return {
                invocationMessage: `Waiting for LEGO run ${options.input.runId} to end`,
                confirmationMessages: {
                    title: "Wait for LEGO program state change",
                    message: "Wait for this run's hub termination/disconnect event and share its state and recent logs with Copilot? Cancelling the wait does not stop the program.",
                },
            };
        },
        invoke: async (options, token) => {
            checkTrusted(token);
            return result(await programRuns.wait(
                options.input.runId,
                options.input.timeoutSeconds ?? 60,
                token,
            ));
        },
    };
    context.subscriptions.push(
        vscode.lm.registerTool("lego_upload_program", uploadTool),
        vscode.lm.registerTool("lego_start_program", createSlotTool(false)),
        vscode.lm.registerTool("lego_stop_program", createSlotTool(true)),
        vscode.lm.registerTool("lego_read_logs", logTool),
        vscode.lm.registerTool("lego_get_telemetry", telemetryTool),
        vscode.lm.registerTool("lego_wait_program", waitTool),
    );
}
