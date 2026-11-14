import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as shellQuote from "shell-quote";
import { v7 } from "uuid";

export function executeCustomPreprocessor(
    command: string,
    filePath: string,
    onStderr: (message: string) => void,
    timeoutMs = 30000,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const [executable, ...args] = shellQuote.parse(command);
        if (!executable) {
            reject(new Error("Custom preprocessor command is empty."));
            return;
        }

        const outputPath = path.join(os.tmpdir(), `${v7()}.py`);
        const descriptors: number[] = [];
        let child: cp.ChildProcess;
        try {
            try {
                descriptors.push(fs.openSync(filePath, "r"));
                descriptors.push(fs.openSync(outputPath, "w"));
                child = cp.spawn(executable.toString(), args.map(arg => arg.toString()), {
                    stdio: [descriptors[0], descriptors[1], "pipe"],
                });
            }
            finally {
                descriptors.forEach(descriptor => fs.closeSync(descriptor));
            }
        }
        catch (error) {
            if (fs.existsSync(outputPath)) {
                fs.rmSync(outputPath);
            }
            reject(error);
            return;
        }
        let failure: Error | undefined;
        const timeout = setTimeout(() => {
            failure = new Error(`Custom preprocessor timed out after ${timeoutMs / 1000} seconds.`);
            if (!child.kill()) {
                onStderr("Unable to terminate timed-out custom preprocessor.");
            }
            reject(failure);
        }, timeoutMs);
        child.stderr?.on("data", data => {
            onStderr(`Custom preprocessor error: ${data.toString().trimEnd()}\n`);
        });
        child.on("error", error => {
            failure = error;
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            if (failure || code !== 0) {
                try {
                    fs.rmSync(outputPath);
                }
                catch (error) {
                    onStderr(`Unable to remove failed preprocessor output: ${error}`);
                }
                reject(failure ?? new Error(`Custom preprocessor exited with ${signal ?? `code ${code}`}.`));
            }
            else {
                resolve(outputPath);
            }
        });
    });
}
