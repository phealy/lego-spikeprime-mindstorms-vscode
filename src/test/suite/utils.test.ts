import * as assert from "assert";

import { formatBluetoothAddress, hasLegoProgramHeader } from "../../utils";

suite("Utils Test Suite", () => {
    test("Formats a compact Bluetooth address", () => {
        assert.strictEqual(
            formatBluetoothAddress("aabbccddeeff"),
            "AA:BB:CC:DD:EE:FF",
        );
    });

    test("Normalizes an already separated Bluetooth address", () => {
        assert.strictEqual(
            formatBluetoothAddress("aa:bb:cc:dd:ee:ff"),
            "AA:BB:CC:DD:EE:FF",
        );
    });

    test("Recognizes a LEGO program header only at the start of the first line", () => {
        assert.strictEqual(hasLegoProgramHeader("# LEGO slot:3 autostart"), true);
        assert.strictEqual(hasLegoProgramHeader(" # LEGO slot:3"), false);
        assert.strictEqual(hasLegoProgramHeader("# lego slot:3"), false);
        assert.strictEqual(hasLegoProgramHeader("print('LEGO')"), false);
    });
});