import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { Logger } from "../../logger";

suite("Logger Test Suite", () => {
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