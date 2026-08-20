import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
    mergeHubOS3StubPath,
    mergeHubOS3StubPathSetting,
    mergeMissingModuleSourceOverride,
} from "../../pylance-stubs";

suite("Pylance HubOS3 Stubs Test Suite", () => {
    const currentPath = "C:\\extensions\\development\\python-stubs";
    const stubsPath = path.resolve(__dirname, "../../../python-stubs");

    test("Appends the bundled stubs without replacing user paths", () => {
        assert.deepStrictEqual(
            mergeHubOS3StubPath(["C:\\project\\typings"], currentPath, true),
            ["C:\\project\\typings", currentPath],
        );
    });

    test("Replaces paths from installed extension versions", () => {
        const oldPath = "C:\\Users\\test\\.vscode\\extensions\\PeterStaev.lego-spikeprime-mindstorms-vscode-3.1.3\\python-stubs";

        assert.deepStrictEqual(
            mergeHubOS3StubPath([oldPath, currentPath], currentPath, true),
            [currentPath],
        );
    });

    test("Removes managed paths when disabled", () => {
        assert.deepStrictEqual(
            mergeHubOS3StubPath(["custom", currentPath], currentPath, false),
            ["custom"],
        );
    });

    test("Uses the bundle as stubPath and restores the previous setting", () => {
        assert.deepStrictEqual(
            mergeHubOS3StubPathSetting("custom-typings", currentPath, true, undefined, false),
            {
                stubPath: currentPath,
                previousPath: "custom-typings",
                ownsSetting: true,
            },
        );
        assert.deepStrictEqual(
            mergeHubOS3StubPathSetting(currentPath, currentPath, false, "custom-typings", true),
            {
                stubPath: "custom-typings",
                previousPath: undefined,
                ownsSetting: false,
            },
        );
    });

    test("Suppresses missing source warnings without replacing other overrides", () => {
        assert.deepStrictEqual(
            mergeMissingModuleSourceOverride({ reportUnusedImport: "error" }, true, false),
            {
                diagnosticOverrides: {
                    reportUnusedImport: "error",
                    reportMissingModuleSource: "none",
                },
                ownsOverride: true,
            },
        );
    });

    test("Preserves a user-defined missing source severity", () => {
        assert.deepStrictEqual(
            mergeMissingModuleSourceOverride({ reportMissingModuleSource: "error" }, true, false),
            {
                diagnosticOverrides: { reportMissingModuleSource: "error" },
                ownsOverride: false,
            },
        );
    });

    test("Removes only an override owned by the extension", () => {
        assert.deepStrictEqual(
            mergeMissingModuleSourceOverride({
                reportMissingModuleSource: "none",
                reportUnusedImport: "warning",
            }, false, true),
            {
                diagnosticOverrides: { reportUnusedImport: "warning" },
                ownsOverride: false,
            },
        );
    });

    test("Exposes a named type for every enum-like constant family", () => {
        const expectedAliases: Record<string, string[]> = {
            "color.pyi": ["Color"],
            "orientation.pyi": ["Orientation"],
            "motor.pyi": [
                "Motor",
                "StateType",
                "StopType",
                "DirectionType",
                "MotorState",
                "MotorBrakeMode",
                "MotorDirection",
            ],
            "motor_pair.pyi": ["MotorPair"],
            "runloop.pyi": ["RunloopStatus"],
            "hub/button.pyi": ["Button"],
            "hub/light.pyi": ["Light"],
            "hub/light_matrix.pyi": ["MatrixImage", "LightMatrixStatus"],
            "hub/motion_sensor.pyi": ["Gesture", "HubFace"],
            "hub/port.pyi": ["Port"],
            "hub/sound.pyi": ["SoundChannel", "Waveform"],
        };

        for (const [relativePath, aliases] of Object.entries(expectedAliases)) {
            const contents = fs.readFileSync(path.join(stubsPath, relativePath), "utf8");

            for (const alias of aliases) {
                assert.match(contents, new RegExp(`^${alias}: TypeAlias = int$`, "m"));
            }
        }

        const stubFiles = fs.readdirSync(stubsPath, { recursive: true })
            .filter(file => file.toString().endsWith(".pyi"));

        for (const stubFile of stubFiles) {
            const contents = fs.readFileSync(path.join(stubsPath, stubFile.toString()), "utf8");
            assert.doesNotMatch(
                contents,
                /^[A-Z][A-Z0-9_]*: Final\[int\]/m,
                `${stubFile} contains an enum-like constant without a named type`,
            );
        }
    });

    test("Exposes HubOS time functions", () => {
        const contents = fs.readFileSync(path.join(stubsPath, "time.pyi"), "utf8");

        assert.match(contents, /^def sleep\(seconds: float\) -> None:$/m);
        assert.match(contents, /^def sleep_ms\(milliseconds: int\) -> None:$/m);
        assert.match(contents, /^def ticks_ms\(\) -> int:$/m);
    });
});