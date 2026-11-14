import * as vscode from "vscode";

import { pack, unpack } from "../cobs";
import { Logger } from "../logger";
import { BaseMessage } from "../messages/base-message";
import { ClearSlotRequestMessage } from "../messages/clear-slot-request-message";
import { ClearSlotResponseMessage } from "../messages/clear-slot-response-message";
import { ConsoleNotificationMessage } from "../messages/console-notification-message";
import { DeviceNotificationMessage } from "../messages/device-notification";
import { DeviceNotificationRequestMessage } from "../messages/device-notification-request";
import { DeviceNotificationResponseMessage } from "../messages/device-notification-response";
import { GetHubNameRequestMessage } from "../messages/get-hub-name-request-message";
import { GetHubNameResponseMessage } from "../messages/get-hub-name-response-message";
import { InfoResponseMessage } from "../messages/info-response-message";
import { ProgramFlowNotificationMessage } from "../messages/program-flow-notification-message";
import { ProgramFlowRequestMessage } from "../messages/program-flow-request-message";
import { ProgramFlowResponseMessage } from "../messages/program-flow-response-message";
import { SetHubNameRequestMessage } from "../messages/set-hub-name-request-message";
import { SetHubNameResponseMessage } from "../messages/set-hub-name-response-message";
import { StartFileUploadRequestMessage } from "../messages/start-file-upload-request-message";
import { StartFileUploadResponseMessage } from "../messages/start-file-upload-response-message";
import { TransferChunkRequestMessage } from "../messages/transfer-chunk-request-message";
import { TransferChunkResponseMessage } from "../messages/transfer-chunk-response-message";

export interface HubQuickPickItem extends vscode.QuickPickItem {
    connectionId: string;
}

interface PendingMessage {
    resolve: (result: BaseMessage) => void;
    reject: (error: Error) => void;
}

export abstract class BaseClient {
    public onClosed: vscode.EventEmitter<void> =
        new vscode.EventEmitter<void>();
    public onProgramRunningChanged: vscode.EventEmitter<boolean> =
        new vscode.EventEmitter<boolean>();
    public onDeviceNotification: vscode.EventEmitter<DeviceNotificationMessage> =
        new vscode.EventEmitter<DeviceNotificationMessage>();
    public abstract get isConnectedIn(): boolean;
    public abstract get transport(): "bluetooth" | "usb";
    public get firmwareVersion() {
        if (!this._infoResponse) {
            return undefined;
        }

        return `${this._infoResponse.firmwareMajor}.${this._infoResponse.firmwareMinor}.${this._infoResponse.firmwareBuild}`;
    }
    public get rpcVersion() {
        if (!this._infoResponse) {
            return undefined;
        }

        return `${this._infoResponse.rpcMajor}.${this._infoResponse.rpcMinor}.${this._infoResponse.rpcBuild}`;
    }
    public get maxChunkSize() {
        if (!this._infoResponse) {
            return undefined;
        }
        return this._infoResponse.maxChunkSize;
    }
    public get hubName() {
        return this._hubName;
    }
    public get macAddress() {
        return this._macAddress;
    }

    protected _logger: Logger;
    protected _pendingMessagesPromises = new Map<number, PendingMessage>();
    protected _infoResponse: InfoResponseMessage | undefined;
    protected _hubName: string | undefined;
    protected _macAddress: string | undefined;
    private _isConnectionLogged = false;
    private _requestTimedOut = false;

    protected get requestTimeoutMs() {
        return 10000;
    }

    constructor(logger: Logger) {
        this._logger = logger;
    }

    public abstract list(
        onDidChange: (items: readonly HubQuickPickItem[]) => void,
        cancellationToken: vscode.CancellationToken,
    ): Promise<HubQuickPickItem[]>;

    public abstract connect(peripheralUuid: string): Promise<void>;

    public reconnect(peripheralUuid: string): Promise<void> {
        return this.connect(peripheralUuid);
    }

    public abstract disconnect(): Promise<void>;

    public async startStopProgram(slot: number, isStopIn = false) {
        const response = await this.sendMessage<
            ProgramFlowRequestMessage,
            ProgramFlowResponseMessage
        >(
            new ProgramFlowRequestMessage(slot, isStopIn),
            ProgramFlowResponseMessage,
        );
        return response.IsAckIn;
    }

    public async setHubName(name: string) {
        const response = await this.sendMessage<
            SetHubNameRequestMessage,
            SetHubNameResponseMessage
        >(
            new SetHubNameRequestMessage(name),
            SetHubNameResponseMessage,
        );

        if (response.IsAckIn) {
            this._hubName = name;
        }

        return response.IsAckIn;
    }

    public async loadHubName() {
        const response = await this.sendMessage<
            GetHubNameRequestMessage,
            GetHubNameResponseMessage
        >(
            new GetHubNameRequestMessage(),
            GetHubNameResponseMessage,
        );
        this._hubName = response.name;

        return this._hubName;
    }

    public logConnected() {
        this._logger.info(
            `Connected to hub ${this._hubName ?? "Unknown"} (MAC ${this._macAddress ?? "N/A"}).\r\n`,
        );
        this._isConnectionLogged = true;
    }

    public async startFileUpload(fileName: string, slot: number, crc: number) {
        const uploadResponse = await this.sendMessage<
            StartFileUploadRequestMessage,
            StartFileUploadResponseMessage
        >(
            new StartFileUploadRequestMessage(fileName, slot, crc),
            StartFileUploadResponseMessage,
        );

        if (!uploadResponse.IsAckIn) {
            throw new Error("Failed to start file upload");
        }
    }

    public async clearSlot(slot: number) {
        const response = await this.sendMessage<
            ClearSlotRequestMessage,
            ClearSlotResponseMessage
        >(
            new ClearSlotRequestMessage(slot),
            ClearSlotResponseMessage,
        );

        return response.IsAckIn;
    }

    public async transferChunk(chunk: Uint8Array, runningCrc: number) {
        const response = await this.sendMessage<
            TransferChunkRequestMessage,
            TransferChunkResponseMessage
        >(
            new TransferChunkRequestMessage(runningCrc, chunk),
            TransferChunkResponseMessage,
        );

        if (!response.IsAckIn) {
            throw new Error("Failed to transfer chunk");
        }
    }

    public async startDeviceNotifications() {
        const config = vscode.workspace.getConfiguration(
            "legoSpikePrimeMindstorms",
        );
        const intervalMs = config.get<number>("telemetryInterval") ?? 100;
        const response = await this.sendMessage<
            DeviceNotificationRequestMessage,
            DeviceNotificationResponseMessage
        >(
            new DeviceNotificationRequestMessage(intervalMs),
            DeviceNotificationResponseMessage,
        );

        if (!response.IsAckIn) {
            throw new Error("Failed to start device notifications");
        }

        return response;
    }

    public async stopDeviceNotifications() {
        const response = await this.sendMessage<
            DeviceNotificationRequestMessage,
            DeviceNotificationResponseMessage
        >(
            new DeviceNotificationRequestMessage(0),
            DeviceNotificationResponseMessage,
        );

        if (!response.IsAckIn) {
            throw new Error("Failed to stop device notifications");
        }

        return response;
    }

    protected abstract writeData(data: Uint8Array): Promise<void> | undefined;

    protected async sendMessage<T extends BaseMessage, U extends BaseMessage>(
        message: T,
        result: typeof BaseMessage,
    ): Promise<U> {
        if (!this.isConnectedIn || (this._requestTimedOut && result !== InfoResponseMessage)) {
            throw new Error("Hub connection is unavailable. Please reconnect before trying again.");
        }
        if (this._pendingMessagesPromises.has(result.Id)) {
            throw new Error(`A hub request for response 0x${result.Id.toString(16)} is already pending.`);
        }

        const serialized = message.serialize();
        const payload = pack(serialized);
        const requestId = serialized[0];
        const packetSize = this._infoResponse?.maxPacketSize ?? payload.length;
        if (!Number.isInteger(packetSize) || packetSize <= 0) {
            throw new Error(`Invalid hub packet size: ${packetSize}`);
        }

        const resultPromise = new Promise<BaseMessage>((resolve, reject) => {
            let response: BaseMessage | undefined;
            let written = false;
            const finish = () => {
                clearTimeout(timeout);
                if (this._pendingMessagesPromises.get(result.Id) === pending) {
                    this._pendingMessagesPromises.delete(result.Id);
                }
            };
            const resolveIfComplete = () => {
                if (written && response) {
                    finish();
                    resolve(response);
                }
            };
            const pending: PendingMessage = {
                resolve: value => {
                    response = value;
                    resolveIfComplete();
                },
                reject: error => {
                    finish();
                    reject(error);
                },
            };
            const timeout = setTimeout(() => {
                const error = new Error(
                    `Hub request 0x${requestId.toString(16)} timed out after ${this.requestTimeoutMs / 1000} seconds. Please reconnect.`,
                );
                this._requestTimedOut = true;
                this.rejectPendingMessages(error);
                void this.disconnect().catch(disconnectError => {
                    this._logger.error(`Unable to disconnect unresponsive hub: ${disconnectError}`);
                });
            }, this.requestTimeoutMs);
            this._pendingMessagesPromises.set(result.Id, pending);

            void this.writeMessage(payload, packetSize, result.Id, pending).then(
                () => {
                    written = true;
                    resolveIfComplete();
                },
                error => {
                    pending.reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });

        return resultPromise as Promise<U>;
    }

    private async writeMessage(
        payload: Uint8Array,
        packetSize: number,
        responseId: number,
        pending: PendingMessage,
    ) {
        this._logger.rawMessage("out", this.transport, payload);
        for (let loop = 0; loop < payload.length; loop += packetSize) {
            if (this._pendingMessagesPromises.get(responseId) !== pending) {
                return;
            }
            const write = this.writeData(payload.slice(loop, loop + packetSize));
            if (!write) {
                throw new Error("Hub transport is unavailable.");
            }
            await write;
        }
    }

    private rejectPendingMessages(error: Error) {
        for (const pending of this._pendingMessagesPromises.values()) {
            pending.reject(error);
        }
    }

    protected onData(data: Uint8Array) {
        this._logger.rawMessage("in", this.transport, data);
        const bodyStart = data[0] === 0x01 ? 1 : 0;
        const bodyLength = data.length - bodyStart - 1;
        if (
            data[data.length - 1] === 0x02 &&
            (bodyLength === 0 || (bodyLength === 1 && data[bodyStart] === 0x00))
        ) {
            // Empty framing carries no message ID; retain it only in the raw log.
            return;
        }

        let unpacked: Uint8Array | undefined;
        try {
            unpacked = unpack(data);
            const [messageId, resultMessage] = deserializeMessage(unpacked);
            const pendingMessage = this._pendingMessagesPromises.get(messageId);
            if (pendingMessage) {
                if (resultMessage instanceof InfoResponseMessage) {
                    this._requestTimedOut = false;
                }
                pendingMessage.resolve(resultMessage);
            }
            else if (
                resultMessage instanceof ProgramFlowNotificationMessage
            ) {
                this.onProgramRunningChanged.fire(!resultMessage.isStopIn!);
            }
            else if (resultMessage instanceof ConsoleNotificationMessage) {
                this._logger.log(resultMessage.message ?? "");
            }
            else if (resultMessage instanceof DeviceNotificationMessage) {
                this.onDeviceNotification.fire(resultMessage);
            }
        }
        catch (e) {
            if (unpacked) {
                this._pendingMessagesPromises.get(unpacked[0])?.reject(
                    new Error(`Invalid hub response: ${e}`),
                );
            }
            const frame = unpacked ?? data;
            const hex = [...frame]
                .map(byte => byte.toString(16).padStart(2, "0"))
                .join(" ");
            const rawHex = [...data]
                .map(byte => byte.toString(16).padStart(2, "0"))
                .join(" ");
            this._logger.error(
                `Error deserializing message (${frame.length} bytes: ${hex}; raw ${data.length} bytes: ${rawHex}): ${e}`,
            );
        }
    }

    protected onDisconnect() {
        if (this._isConnectionLogged) {
            this._logger.info(
                `Disconnected from hub ${this._hubName ?? "Unknown"} (MAC ${this._macAddress ?? "N/A"}).\r\n`,
            );
        }
        this._infoResponse = undefined;
        this._hubName = undefined;
        this._macAddress = undefined;
        this._isConnectionLogged = false;
        this.rejectPendingMessages(new Error("Hub disconnected during a request."));

        this.onClosed.fire();
    }
}

function deserializeMessage(
    data: Uint8Array,
): [id: number, message: BaseMessage] {
    const messageId = data[0];
    let message: BaseMessage;

    switch (messageId) {
        case ClearSlotResponseMessage.Id:
            message = new ClearSlotResponseMessage();
            break;
        case DeviceNotificationMessage.Id:
            message = new DeviceNotificationMessage();
            break;
        case DeviceNotificationResponseMessage.Id:
            message = new DeviceNotificationResponseMessage();
            break;
        case GetHubNameResponseMessage.Id:
            message = new GetHubNameResponseMessage();
            break;
        case InfoResponseMessage.Id:
            message = new InfoResponseMessage();
            break;

        case ProgramFlowNotificationMessage.Id:
            message = new ProgramFlowNotificationMessage();
            break;

        case ProgramFlowResponseMessage.Id:
            message = new ProgramFlowResponseMessage();
            break;

        case SetHubNameResponseMessage.Id:
            message = new SetHubNameResponseMessage();
            break;

        case ConsoleNotificationMessage.Id:
            message = new ConsoleNotificationMessage();
            break;

        case StartFileUploadResponseMessage.Id:
            message = new StartFileUploadResponseMessage();
            break;

        case TransferChunkResponseMessage.Id:
            message = new TransferChunkResponseMessage();
            break;

        default:
            throw new Error(`Unknown message ID: ${messageId}`);
    }

    message.deserialize(data);

    return [messageId, message];
}
