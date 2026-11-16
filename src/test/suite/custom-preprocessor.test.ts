import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { executeCustomPreprocessor } from "../../custom-preprocessor";

suite("Custom Preprocessor Test Suite", () => {
    let directory: string;
    let input: string;
    let script: string;

    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "lego-preprocessor-test-"));
        input = path.join(directory, "input.py");
        script = path.join(directory, "preprocessor.js");
        fs.writeFileSync(input, "print('hello')");
    });

    teardown(async () => {
        await fs.promises.rm(directory, {
            recursive: true,
            maxRetries: 5,
            retryDelay: 100,
        });
    });

    const run = (source: string, timeoutMs = 30000, token?: vscode.CancellationToken) => {
        fs.writeFileSync(script, source);
        const executable = process.env.npm_node_execpath ?? process.execPath;
        const command = `"${executable.replace(/\\/g, "\\\\")}" "${script.replace(/\\/g, "\\\\")}"`;
        return executeCustomPreprocessor(command, input, message => assert.fail(message), timeoutMs, token);
    };

    test("Preserves stdin/stdout preprocessing", async () => {
        const output = await run("process.stdout.write(require('fs').readFileSync(0));");
        try {
            assert.strictEqual(fs.readFileSync(output, "utf8"), "print('hello')");
        }
        finally {
            fs.rmSync(output);
        }
    });

    test("Reports an executable that cannot start", async () => {
        await assert.rejects(
            executeCustomPreprocessor("nonexistent-lego-preprocessor", input, message => assert.fail(message)),
            /ENOENT/,
        );
    });

    test("Rejects nonzero exits", async () => {
        await assert.rejects(run("process.exit(2);"), /code 2/);
    });

    test("Terminates a hung preprocessor at the configured deadline", async () => {
        const started = Date.now();
        await assert.rejects(run("setInterval(() => {}, 1000);", 100), /timed out after 0.1 seconds/);
        assert.ok(Date.now() - started < 2000);
    });

    test("Disconnect cancellation terminates a running preprocessor", async () => {
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = run("setInterval(() => {}, 1000);", 30000, cancellation.token);
            const rejected = assert.rejects(result, /disconnected/);
            cancellation.cancel();
            await rejected;
        }
        finally {
            cancellation.dispose();
        }
    });
});
