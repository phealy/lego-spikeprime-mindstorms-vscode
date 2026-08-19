import * as vscode from "vscode";

import { BaseClient } from "../clients/base-client";
import { getTelemetryDashboardHtml } from "./telemetry-dashboard-v2";

export class LiveDataViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "legoLiveView";

    private _view?: vscode.WebviewView;
    private readonly webviews = new Set<vscode.Webview>();
    private panel?: vscode.WebviewPanel;
    private telemetry?: any;

    constructor(private readonly getClient: () => BaseClient | undefined) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        this.registerWebview(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.render(webviewView.webview);
            }
        });

        webviewView.onDidDispose(() => {
            this.webviews.delete(webviewView.webview);
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });
    }

    public showPanel() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "legoLiveTelemetryPanel",
            "LEGO Hub Live Data",
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const webview = panel.webview;
        this.panel = panel;
        this.registerWebview(webview);
        panel.onDidDispose(() => {
            this.webviews.delete(webview);
            if (this.panel === panel) {
                this.panel = undefined;
            }
        });
    }

    public updateTelemetry(data: any) {
        this.telemetry = data;

        for (const webview of this.webviews) {
            webview.postMessage({ type: "telemetry", data });
        }
    }

    public setClientStateChanged() {
        for (const webview of this.webviews) {
            this.render(webview);
        }
    }

    private registerWebview(webview: vscode.Webview) {
        this.webviews.add(webview);
        webview.options = { enableScripts: true };
        webview.html = getTelemetryDashboardHtml();
        webview.onDidReceiveMessage((msg) => {
            if (msg.type === "connect") {
                void vscode.commands.executeCommand(
                    "lego-spikeprime-mindstorms-vscode.connectToHub",
                );
            }
            else if (msg.type === "ready") {
                this.render(webview);
            }
        });
        this.render(webview);
    }

    private render(webview: vscode.Webview) {
        const client = this.getClient();

        webview.postMessage({
            type: "state",
            connected: client?.isConnectedIn ?? false,
            transport: client?.isConnectedIn ? client.transport : undefined,
        });
        if (this.telemetry) {
            webview.postMessage({ type: "telemetry", data: this.telemetry });
        }
    }

    private _getLegacyHtml() {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LEGO Live Data</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    padding: 12px;
                }

                h1 {
                    font-size: 14px;
                    font-weight: 600;
                    margin-bottom: 12px;
                }

                .card {
                    background-color: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                    padding: 10px;
                    margin-bottom: 10px;
                }

                .status {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 500;
                }

                .dot {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    background: var(--vscode-errorForeground);
                }

                .dot.connected {
                    background: var(--vscode-testing-iconPassed);
                }

                pre {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    background: var(--vscode-textCodeBlock-background);
                    padding: 8px;
                    border-radius: 4px;
                    overflow: auto;
                }

                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 10px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-top: 8px;
                }

                button:hover {
                    background: var(--vscode-button-hoverBackground);
                }

                button:active {
                    transform: translateY(1px);
                }
            </style>
        </head>

        <body>
            <h1>LEGO Live Telemetry</h1>

        <div class="card">
            <div class="status">
                <div id="dot" class="dot"></div>
                <span id="statusText">Disconnected</span>
            </div>

            <button id="connectBtn" style="margin-top:8px;">Connect Hub</button>
        </div>

        <div class="card">
            <h3>Telemetry</h3>
            <pre id="data">Waiting for data...</pre>
        </div>

            <script>
                const vscode = acquireVsCodeApi();

                const connectBtn = document.getElementById("connectBtn");
                const dataEl = document.getElementById("data");

                const dot = document.getElementById("dot");
                const statusText = document.getElementById("statusText");

                const oldState = vscode.getState();
                if (oldState) {
                    if (oldState.data) {
                        dataEl.textContent = oldState.data;
                    }

                    if (oldState.connected) {
                        connectBtn.textContent = "Reconnect Hub";
                    }
                }

                connectBtn.addEventListener("click", () => {
                    vscode.postMessage({ type: "connect" });
                });

                window.addEventListener("message", (event) => {
                    const msg = event.data;

                    if (msg.type === "telemetry") {
                        const text = JSON.stringify(msg.data, null, 2);

                        dataEl.textContent = text;

                        vscode.setState({
                            data: text,
                            connected: true
                        });
                    }

                    if (msg.type === "state") {
                        if (msg.connected) {
                            dot.classList.add("connected");
                            statusText.textContent = "Connected";
                            connectBtn.textContent = "Reconnect";
                        } else {
                            dot.classList.remove("connected");
                            statusText.textContent = "Disconnected";
                            connectBtn.textContent = "Connect Hub";
                        }
                    }
                });
                if (!oldState) {
                    vscode.setState({
                        data: "No data yet...",
                        connected: false
                    });
                }
            </script>
        </body>
        </html>`;
    }
}
