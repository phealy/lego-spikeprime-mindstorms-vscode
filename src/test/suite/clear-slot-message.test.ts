import * as assert from "assert";

import { ClearSlotRequestMessage } from "../../messages/clear-slot-request-message";
import { ClearSlotResponseMessage } from "../../messages/clear-slot-response-message";

suite("Clear Slot Message Test Suite", () => {
    test("Serializes the target slot", () => {
        assert.deepStrictEqual(
            new ClearSlotRequestMessage(5).serialize(),
            Uint8Array.from([0x46, 5]),
        );
    });

    test("Deserializes an acknowledged response", () => {
        const response = new ClearSlotResponseMessage();
        response.deserialize(Uint8Array.from([0x47, 0x00]));
        assert.strictEqual(response.IsAckIn, true);
    });
});