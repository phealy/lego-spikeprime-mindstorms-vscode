import * as mpy from "@pybricks/mpy-cross-v6";

import * as vscode from "vscode";

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
} from "../shared-extension";
import {
    Command,
    formatProgramLog,
    getImportedModuleNames,
    setTimeoutAsync,
} from "../utils";
import { WebUsbClient } from "./clients/web-usb-client";

let wasmUri: vscode.Uri;

export async function activate(context: vscode.ExtensionContext) {
    wasmUri = vscode.Uri.joinPath(context.extensionUri, "dist/mpy-cross-v6.wasm");

    initHubStatusBarItems(context);
    configureRawMessageLogging(context);

    registerSharedCommands(context);

    const connectToHubCommand = vscode.commands.registerCommand(Command.ConnectToHub, async () => {
        try {
            initClient(WebUsbClient);

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Connecting to Hub...",
                },
                () => getClient()!.connect(""),
            );

            await onHubConnected();
        }
        catch (e) {
            console.error(e);
            vscode.window.showErrorMessage("Connecting to Hub Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
        }
    });

    const uploadProgramCommand = vscode.commands.registerCommand(Command.UploadProgram, async () => {
        if (!getClient()?.isConnectedIn) {
            vscode.window.showErrorMessage("LEGO Hub not connected! Please connect first!");
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
            vscode.window.showErrorMessage("Program Upload Failed!" + (e instanceof Error ? ` ${e.message}` : ""));
        }
    });
    context.subscriptions.push(
        connectToHubCommand,
        uploadProgramCommand,
    );
}

// this method is called when your extension is deactivated
export async function deactivate() {
    await onDeactivate();
}

async function findIncludedFile(
    fileName: string,
    documentUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
    const programDirectory = vscode.Uri.joinPath(documentUri, "..");
    const projectDirectory = vscode.workspace.getWorkspaceFolder(documentUri)?.uri
        ?? programDirectory;
    let currentDirectory = programDirectory;

    while (true) {
        const candidateUri = vscode.Uri.joinPath(currentDirectory, fileName);
        try {
            await vscode.workspace.fs.readFile(candidateUri);
            return candidateUri;
        }
        catch {
            if (currentDirectory.toString() === projectDirectory.toString()) {
                return undefined;
            }
            currentDirectory = vscode.Uri.joinPath(currentDirectory, "..");
        }
    }
}

async function performUploadProgram(
    slotId: number,
    includeFileNames: string[],
    progress?: vscode.Progress<{ increment: number }>,
) {
    const editor = vscode.window.activeTextEditor;
    const config = vscode.workspace.getConfiguration();
    const logger = getLogger();

    if (!editor) {
        vscode.window.showInformationMessage("Please open a file");
        return;
    }

    const document = editor.document;
    const documentContent = document.getText();
    const compileBeforeUpload = config.get<boolean>(
        "legoSpikePrimeMindstorms.compileBeforeUpload",
    ) ?? false;
    const includeFiles = await Promise.all(includeFileNames.map(async (name) => {
        if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
            throw new Error(`Included file must be a file name: ${name}`);
        }
        if (new TextEncoder().encode(name).length > 31) {
            throw new Error(`Included file name is too long: ${name}`);
        }

        const uri = await findIncludedFile(name, document.uri);
        if (!uri) {
            throw new Error(`Included file not found: ${name}`);
        }
        return { name, uri, data: await vscode.workspace.fs.readFile(uri) };
    }));
    const importedFiles = await loadImportedFiles(
        document.uri,
        documentContent,
        includeFiles,
    );

    let compileResult: mpy.CompileResult | undefined;
    if (compileBeforeUpload) {
        compileResult = await mpy.compile(
            document.fileName,
            documentContent,
            [],
            wasmUri.toString(),
        );

        if (compileResult?.status !== 0) {
            logger?.error(formatProgramLog(
                slotId,
                `compilation failed for ${document.fileName}:\r\n`,
            ));
            logger?.error(
                compileResult.err
                    .map(error => formatProgramLog(slotId, error))
                    .join("\r\n") + "\r\n",
            );
            throw new Error("Compilation Failed!");
        }
    }

    const data = compileResult?.mpy ?? new TextEncoder().encode(documentContent);
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
        document.uri.path.split("/").pop() ?? document.fileName,
        slotId,
        !!compileResult?.mpy,
        progress,
    );
}

async function prepareAuxiliaryFiles(
    files: Array<{ name: string, data: Uint8Array }>,
    compileBeforeUpload: boolean,
    slotId: number,
): Promise<Array<{ name: string, sourceName: string, data: Uint8Array }>> {
    const logger = getLogger();
    const preparedFiles: Array<{ name: string, sourceName: string, data: Uint8Array }> = [];

    for (const file of files) {
        if (!compileBeforeUpload || !file.name.toLowerCase().endsWith(".py")) {
            preparedFiles.push({ ...file, sourceName: file.name });
            continue;
        }

        const compileResult = await mpy.compile(
            file.name,
            new TextDecoder().decode(file.data),
            [],
            wasmUri.toString(),
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

async function loadImportedFiles(
    programUri: vscode.Uri,
    programSource: string,
    includeFiles: Array<{ name: string, uri: vscode.Uri, data: Uint8Array }>,
): Promise<Array<{ name: string, data: Uint8Array }>> {
    const knownNames = new Set([
        programUri.path.split("/").pop() ?? programUri.path,
        ...includeFiles.map(file => file.name),
    ]);
    const pendingSources: Array<{ uri: vscode.Uri, source: string }> = [
        { uri: programUri, source: programSource },
        ...includeFiles
            .filter(file => file.name.toLowerCase().endsWith(".py"))
            .map(file => ({
                uri: file.uri,
                source: new TextDecoder().decode(file.data),
            })),
    ];
    const importedFiles: Array<{ name: string, data: Uint8Array }> = [];

    while (pendingSources.length > 0) {
        const { uri: sourceUri, source } = pendingSources.shift()!;
        for (const moduleName of getImportedModuleNames(source)) {
            const name = `${moduleName}.py`;
            if (knownNames.has(name)) {
                continue;
            }
            if (new TextEncoder().encode(name).length > 31) {
                throw new Error(`Imported file name is too long: ${name}`);
            }

            const uri = await findIncludedFile(name, sourceUri);
            if (!uri) {
                continue;
            }
            const data = await vscode.workspace.fs.readFile(uri);

            knownNames.add(name);
            importedFiles.push({ name, data });
            pendingSources.push({ uri, source: new TextDecoder().decode(data) });
        }
    }

    return importedFiles;
}