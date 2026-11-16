import * as vscode from "vscode";

import type { BaseClient } from "./clients/base-client";

export class HubDisconnectedError extends Error {
    constructor() {
        super("Hub disconnected. Operation cancelled.");
    }
}

export class HubOperation implements vscode.Disposable {
    private readonly cancellation = new vscode.CancellationTokenSource();
    private readonly closed: vscode.Disposable;
    private readonly externalCancellation: vscode.Disposable | undefined;

    public get token(): vscode.CancellationToken {
        return this.cancellation.token;
    }

    constructor(public readonly client: BaseClient, private readonly externalToken?: vscode.CancellationToken) {
        this.closed = client.onClosed.event(() => this.cancellation.cancel());
        this.externalCancellation = externalToken?.onCancellationRequested(() => this.cancellation.cancel());
        if (externalToken?.isCancellationRequested) {
            this.cancellation.cancel();
        }
    }

    public check(): void {
        if (this.token.isCancellationRequested) {
            if (this.externalToken?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            throw new HubDisconnectedError();
        }
    }

    public async wait<T>(task: () => PromiseLike<T>): Promise<T> {
        this.check();
        let subscription: vscode.Disposable | undefined;
        try {
            const cancelled = new Promise<never>((resolve, reject) => {
                subscription = this.token.onCancellationRequested(() => reject(
                    this.externalToken?.isCancellationRequested
                        ? new vscode.CancellationError()
                        : new HubDisconnectedError(),
                ));
            });
            const result = await Promise.race([task(), cancelled]);
            this.check();
            return result;
        }
        finally {
            subscription?.dispose();
        }
    }

    public dispose(): void {
        this.closed.dispose();
        this.externalCancellation?.dispose();
        this.cancellation.dispose();
    }
}
