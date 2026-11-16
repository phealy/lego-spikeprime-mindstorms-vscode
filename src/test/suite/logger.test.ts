import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { Logger } from "../../logger";

suite("Logger Test Suite", () => {
    test("Retains plain timestamped output while preserving colored terminal writes", () => {
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(emitter, () => new Date("2026-09-07T12:34:56.789Z"));
        try {
            logger.info("upload ");
            logger.error("failed\r\n");
            logger.log("\u001b[31mprogram output\u001b[0m\r\n");
            assert.deepStrictEqual(logger.readOutput(), {
                text: "[2026-09-07T12:34:56.789Z] upload failed\r\n[2026-09-07T12:34:56.789Z] program output\r\n",
                truncated: false,
            });
        }
        finally {
            emitter.dispose();
        }
    });

    test("Bounds retained output, reports truncation, and clears the readable buffer", () => {
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(emitter);
        try {
            logger.log("x".repeat(70000));
            assert.deepStrictEqual(logger.readOutput(32768), { text: "x".repeat(32768), truncated: true });
            assert.deepStrictEqual(logger.readOutput(3), { text: "xxx", truncated: true });
            for (const limit of [0, -1, 1.5, 32769, NaN]) {
                assert.throws(() => logger.readOutput(limit), /maxCharacters/);
            }
            logger.clear();
            assert.deepStrictEqual(logger.readOutput(), { text: "", truncated: false });
            logger.log("new\r\n");
            assert.ok(logger.readOutput().text.endsWith("] new\r\n"));
            assert.strictEqual(logger.readOutput().truncated, false);
        }
        finally {
            emitter.dispose();
        }
    });

    test("Clears terminal scrollback and restarts timestamps after a partial line", () => {
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(emitter, () => new Date("2026-09-07T12:34:56.789Z"));
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));

        try {
            logger.log("previous partial line");
            logger.clear();
            logger.log("new execution\r\n");

            assert.strictEqual(output[1], "\u001b[3J\u001b[2J\u001b[H");
            assert.strictEqual(output[2], "[2026-09-07T12:34:56.789Z] new execution\r\n");
        }
        finally {
            subscription.dispose();
            emitter.dispose();
        }
    });

    test("Writes blue operation fragments on one terminal line", () => {
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(
            emitter,
            () => new Date("2026-09-07T12:34:56.789Z"),
        );
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));

        logger.info("Slot 00: uploading gadget.py...");
        logger.info("done.\r\n");

        assert.strictEqual(
            output.join(""),
            "\u001b[36m[2026-09-07T12:34:56.789Z] Slot 00: uploading gadget.py...\u001b[0m" +
                "\u001b[36mdone.\r\n\u001b[0m",
        );

        subscription.dispose();
        emitter.dispose();
    });

    test("Timestamps each complete or fragmented log line once", () => {
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(
            emitter,
            () => new Date("2026-09-07T12:34:56.789Z"),
        );
        const output: string[] = [];
        const subscription = emitter.event(text => output.push(text));

        logger.log("first ");
        logger.log("line\r\nsecond line\r\n");

        assert.strictEqual(
            output.join(""),
            "[2026-09-07T12:34:56.789Z] first line\r\n" +
                "[2026-09-07T12:34:56.789Z] second line\r\n",
        );

        subscription.dispose();
        emitter.dispose();
    });

    test("Writes raw messages as JSONL", async () => {
        const uri = vscode.Uri.file(path.join(
            os.tmpdir(),
            `lego-raw-messages-${Date.now()}.jsonl`,
        ));
        const emitter = new vscode.EventEmitter<string>();
        const logger = new Logger(emitter);

        try {
            logger.configureRawMessageLog(uri);
            logger.rawMessage("out", "usb", Uint8Array.from([0x01, 0xab]));
            logger.rawMessage("in", "bluetooth", Uint8Array.from([0x00, 0xff]));
            await logger.flushRawMessageLog();

            const lines = new TextDecoder().decode(
                await vscode.workspace.fs.readFile(uri),
            ).trim().split("\n").map(line => JSON.parse(line));

            assert.strictEqual(lines.length, 2);
            assert.deepStrictEqual(
                lines.map(({ direction, transport, data }) => ({ direction, transport, data })),
                [
                    { direction: "out", transport: "usb", data: "01ab" },
                    { direction: "in", transport: "bluetooth", data: "00ff" },
                ],
            );
            assert.ok(lines.every(line => !isNaN(Date.parse(line.timestamp))));
        }
        finally {
            emitter.dispose();
            await vscode.workspace.fs.delete(uri, { useTrash: false });
        }
    });
});