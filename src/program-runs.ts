import * as vscode from "vscode";

import type { BaseClient } from "./clients/base-client";

type RunState = "starting" | "running" | "terminated" | "disconnected" | "superseded" | "startFailed";

export interface ProgramRun {
    runId: string;
    slot: number;
    state: RunState;
    startedAt: string;
    endedAt?: string;
    error?: string;
    logs?: { text: string, truncated: boolean };
}

export class ProgramRuns {
    private readonly runs = new Map<string, ProgramRun>();
    private readonly changed = new vscode.EventEmitter<ProgramRun>();
    private readonly sessionId = Date.now().toString(36);
    private nextId = 0;
    private active: ProgramRun | undefined;
    private listeners: vscode.Disposable[] = [];

    constructor(private readonly readLogs: () => { text: string, truncated: boolean }) {}

    public begin(client: BaseClient, slot: number): string {
        this.supersede();
        const run: ProgramRun = {
            runId: `run-${this.sessionId}-${++this.nextId}`,
            slot,
            state: "starting",
            startedAt: new Date().toISOString(),
        };
        this.active = run;
        this.runs.set(run.runId, run);
        this.listeners = [
            client.onProgramRunningChanged.event(running => {
                if (running) {
                    run.state = "running";
                }
                else {
                    this.finish(run, "terminated");
                }
            }),
            client.onClosed.event(() => this.finish(run, "disconnected")),
        ];
        while (this.runs.size > 100) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.runs.delete(oldest);
        }
        return run.runId;
    }

    public supersede(): void {
        if (this.active) {
            this.finish(this.active, "superseded");
        }
    }

    public fail(runId: string, error: unknown): void {
        const run = this.get(runId);
        if (!run.endedAt) {
            run.error = error instanceof Error ? error.message : String(error);
            this.finish(run, "startFailed");
        }
    }

    public async wait(
        runId: string,
        timeoutSeconds: number,
        token: vscode.CancellationToken,
    ): Promise<ProgramRun & { timedOut: boolean }> {
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
            throw new Error("timeoutSeconds must be an integer from 1 to 300.");
        }
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const run = this.get(runId);
        if (run.endedAt) {
            return { ...run, timedOut: false };
        }
        let listener: vscode.Disposable | undefined;
        let cancellation: vscode.Disposable | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<ProgramRun & { timedOut: boolean }>((resolve, reject) => {
                listener = this.changed.event(updated => {
                    if (updated.runId === runId) {
                        resolve({ ...updated, timedOut: false });
                    }
                });
                cancellation = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
                timeout = setTimeout(() => resolve({
                    ...run,
                    logs: this.readLogs(),
                    timedOut: true,
                }), timeoutSeconds * 1000);
            });
        }
        finally {
            listener?.dispose();
            cancellation?.dispose();
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        }
    }

    private get(runId: string): ProgramRun {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error("Unknown or expired runId. Use the runId returned by legoStart or legoUpload in this extension session.");
        }
        return run;
    }

    private finish(run: ProgramRun, state: RunState): void {
        if (run.endedAt) {
            return;
        }
        run.state = state;
        run.endedAt = new Date().toISOString();
        run.logs = this.readLogs();
        this.listeners.forEach(listener => listener.dispose());
        this.listeners = [];
        this.active = undefined;
        this.changed.fire({ ...run });
    }
}
