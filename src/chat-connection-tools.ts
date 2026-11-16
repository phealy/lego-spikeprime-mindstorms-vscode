import * as vscode from "vscode";

import { BaseClient, HubQuickPickItem } from "./clients/base-client";
import { getClient } from "./shared-extension";

export interface ChatConnections {
    scanBle?: (durationMs: number, token: vscode.CancellationToken) => Promise<HubQuickPickItem[]>;
    scanUsb?: (token: vscode.CancellationToken) => Promise<HubQuickPickItem[]>;
    connectBle?: (connectionId: string, token: vscode.CancellationToken) => Promise<void>;
    connectUsb: (connectionId: string | undefined, token: vscode.CancellationToken) => Promise<void>;
}

export async function disconnectChatClient(client: BaseClient): Promise<void> {
    let closed: vscode.Disposable | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const disconnected = new Promise<void>((resolve, reject) => {
            closed = client.onClosed.event(resolve);
            timeout = setTimeout(() => reject(new Error("Hub disconnect did not complete within 10 seconds.")), 10000);
        });
        await Promise.all([client.disconnect(), disconnected]);
        if (client.isConnectedIn) {
            throw new Error("Hub is still connected after disconnect.");
        }
    }
    finally {
        closed?.dispose();
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

export function registerChatConnectionTools(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
    connections: ChatConnections,
): void {
    const check = (token: vscode.CancellationToken) => {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error("LEGO chat tools require a trusted workspace.");
        }
    };
    const result = (value: object) => new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(value)),
    ]);
    const createConnectTool = (ble: boolean): vscode.LanguageModelTool<{ connectionId?: string }> => ({
        prepareInvocation: (options, token) => {
            check(token);
            return {
                invocationMessage: `Connecting to LEGO hub via ${ble ? "Bluetooth" : "USB"}`,
                confirmationMessages: {
                    title: `Connect LEGO hub via ${ble ? "Bluetooth" : "USB"}`,
                    message: `Connect to ${options.input.connectionId || "an attached USB LEGO hub"}? This does not start a program. In web VS Code, USB requires choosing a device in the browser permission dialog.`,
                },
            };
        },
        invoke: async (options, token) => {
            check(token);
            if (getClient()?.isConnectedIn) {
                throw new Error("A hub is already connected. Disconnect it before connecting another hub.");
            }
            const id = options.input.connectionId;
            if (ble) {
                if (!id?.trim()) {
                    throw new Error("Provide a connectionId returned by legoScanBLE.");
                }
                if (!connections.connectBle) {
                    throw new Error("Bluetooth connections require desktop VS Code.");
                }
                await connections.connectBle(id, token);
            }
            else {
                await connections.connectUsb(id, token);
            }
            check(token);
            const client = getClient();
            if (!client?.isConnectedIn || client.transport !== (ble ? "bluetooth" : "usb")) {
                throw new Error("The requested hub connection was not established.");
            }
            return result({ connected: true, transport: client.transport, hubName: client.hubName ?? null });
        },
    });
    const scanTool: vscode.LanguageModelTool<{ durationSeconds?: number }> = {
        prepareInvocation: (options, token) => {
            check(token);
            return {
                invocationMessage: "Scanning for Bluetooth LEGO hubs",
                confirmationMessages: {
                    title: "Scan for Bluetooth LEGO hubs",
                    message: "Discover nearby LEGO hubs and share their names and connection IDs with Copilot? Discovery may briefly connect to hubs to read their names; no programs will be started.",
                },
            };
        },
        invoke: async (options, token) => {
            check(token);
            const seconds = options.input.durationSeconds ?? 5;
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) {
                throw new Error("durationSeconds must be an integer from 1 to 30.");
            }
            if (!connections.scanBle) {
                throw new Error("Bluetooth scanning requires desktop VS Code.");
            }
            const hubs = await connections.scanBle(seconds * 1000, token);
            check(token);
            return result({
                hubs: hubs.map(hub => ({ name: hub.label, connectionId: hub.connectionId, description: hub.description ?? null })),
            });
        },
    };
    const disconnectTool: vscode.LanguageModelTool<object> = {
        prepareInvocation: (options, token) => {
            check(token);
            return {
                invocationMessage: "Disconnecting LEGO hub",
                confirmationMessages: {
                    title: "Disconnect LEGO hub",
                    message: "Disconnect the current LEGO hub? This cancels pending hub operations but does not stop a running program or motors. Stop the program first if needed.",
                },
            };
        },
        invoke: async (options, token) => {
            check(token);
            const client = getClient();
            if (!client?.isConnectedIn) {
                return result({ connected: false, disconnected: false });
            }
            await disconnectChatClient(client);
            return result({ connected: false, disconnected: true });
        },
    };
    const scanUsbTool: vscode.LanguageModelTool<object> = {
        prepareInvocation: (options, token) => {
            check(token);
            return {
                invocationMessage: "Scanning for USB LEGO hubs",
                confirmationMessages: {
                    title: "Scan for USB LEGO hubs",
                    message: "List attached LEGO USB hubs and share their port names and serial-number connection IDs with Copilot? This does not connect or start a program.",
                },
            };
        },
        invoke: async (options, token) => {
            check(token);
            if (!connections.scanUsb) {
                throw new Error("USB scanning requires desktop VS Code. In web VS Code, use legoConnectUSB to choose a device.");
            }
            const hubs = await connections.scanUsb(token);
            check(token);
            return result({
                hubs: hubs.map(hub => ({ name: hub.label, connectionId: hub.connectionId, description: hub.description ?? null })),
            });
        },
    };
    context.subscriptions.push(
        vscode.lm.registerTool("lego_scan_ble", scanTool),
        vscode.lm.registerTool("lego_scan_usb", scanUsbTool),
        vscode.lm.registerTool("lego_connect_ble", createConnectTool(true)),
        vscode.lm.registerTool("lego_connect_usb", createConnectTool(false)),
        vscode.lm.registerTool("lego_disconnect", disconnectTool),
    );
}
