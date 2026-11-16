import * as vscode from "vscode";

import { BaseClient, HubQuickPickItem } from "../../clients/base-client";
import { InfoRequestMessage } from "../../messages/info-request-message";
import { InfoResponseMessage } from "../../messages/info-response-message";
import { getLogger } from "../../shared-extension";
import { MessageTransformer } from "../message-transformer";

const VENDOR_ID = 0x0694;
const PRODUCT_ID = 0x0009;

export class WebUsbClient extends BaseClient {
    private _port: SerialPort | undefined;
    private _writer: WritableStreamDefaultWriter | undefined;
    private _reader: ReadableStreamDefaultReader | undefined;
    private readonly _onPortDisconnect = () => {
        void this.disconnect().catch(error => {
            getLogger().error(`Unable to disconnect USB port: ${error}`);
        });
    };

    public get isConnectedIn(): boolean {
        return this._port?.readable !== undefined && this._port?.writable !== undefined;
    }

    public get transport(): "usb" {
        return "usb";
    }

    public list(
        _onDidChange: (items: readonly HubQuickPickItem[]) => void,
        _cancellationToken: vscode.CancellationToken,
    ): Promise<HubQuickPickItem[]> {
        throw new Error("Method not implemented.");
    }

    public async connect(peripheralUuid: string): Promise<void> {
        const portInfo: SerialPortInfo | undefined = await vscode.commands.executeCommand("workbench.experimental.requestSerialPort", { filters: [{ usbVendorId: VENDOR_ID, usbProductId: PRODUCT_ID }] });
        const ports = await navigator.serial.getPorts();
        this._port = ports.find((port) => {
            const info = port.getInfo();
            return info.vendorId === portInfo?.vendorId
                && info.productId === portInfo?.productId
                && info.locationId === portInfo?.locationId;
        });

        if (!this._port) {
            throw new Error("No USB device found with the specified vendor and product ID.");
        }

        await this._port.open({ baudRate: 115200 });

        this._port.addEventListener("disconnect", this._onPortDisconnect);

        void this.readerLoop();

        this._writer = this._port.writable.getWriter();

        return new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                this.sendMessage(new InfoRequestMessage(), InfoResponseMessage).then(
                    (response) => {
                        this._infoResponse = response as InfoResponseMessage;
                        resolve();
                    },
                    (error) => {
                        reject(error);
                    },
                );
            }, 250); // This is needed to make sure the device is fully inited.
        });
    }

    public async disconnect(): Promise<void> {
        const port = this._port;
        const reader = this._reader;
        const writer = this._writer;
        if (!port) {
            return;
        }
        port.removeEventListener("disconnect", this._onPortDisconnect);
        this.onDisconnect();

        const results = await Promise.allSettled([
            (async () => {
                try {
                    await reader?.cancel();
                }
                finally {
                    reader?.releaseLock();
                }
            })(),
            (async () => {
                try {
                    await writer?.abort();
                }
                finally {
                    writer?.releaseLock();
                }
            })(),
        ]);
        for (const result of results) {
            if (result.status === "rejected") {
                getLogger().error(`Unable to release disconnected USB stream: ${result.reason}`);
            }
        }
        try {
            await port.close();
        }
        catch (error) {
            getLogger().error(`Unable to close disconnected USB port: ${error}`);
        }
    }

    protected writeData(data: Buffer): Promise<void> | undefined {
        return this._writer?.write(data);
    }

    protected onDisconnect() {
        this._reader = undefined;
        this._writer = undefined;
        this._port = undefined;

        super.onDisconnect();
    }

    private async readerLoop() {
        while (this._port?.readable && !this._port.readable.locked) {
            const reader = this._port.readable.pipeThrough(new TransformStream(new MessageTransformer())).getReader();
            this._reader = reader;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done || this._reader !== reader) {
                        break;
                    }

                    this.onData(value);
                }
            }
            catch (error) {
                getLogger().error(`Error reading from USB port:${error instanceof Error ? ` ${error.message}` : error}`);
            }
            finally {
                reader.releaseLock();
            }
        }
    }
}