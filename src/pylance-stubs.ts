import * as path from "path";
import * as vscode from "vscode";

const CONFIGURATION_SECTION = "python.analysis";
const DIAGNOSTIC_OVERRIDES_SETTING = "diagnosticSeverityOverrides";
const EXTRA_PATHS_SETTING = "extraPaths";
const ENABLE_SETTING = "legoSpikePrimeMindstorms.enableHubOS3Stubs";
const EXTENSION_DIRECTORY_PREFIX = "peterstaev.lego-spikeprime-mindstorms-vscode-";
const MISSING_MODULE_SOURCE_RULE = "reportMissingModuleSource";
const OWNS_MISSING_MODULE_OVERRIDE_KEY = "hubOS3Stubs.ownsMissingModuleSourceOverride";
const OWNS_STUB_PATH_KEY = "hubOS3Stubs.ownsStubPath";
const PREVIOUS_STUB_PATH_KEY = "hubOS3Stubs.previousStubPath";
const STUB_PATH_SETTING = "stubPath";
const STUBS_DIRECTORY = "python-stubs";

function normalizePath(value: string): string {
    return path.normalize(value).replace(/\\/g, "/").toLowerCase();
}

function isManagedStubsPath(value: string, currentPath: string): boolean {
    const normalized = normalizePath(value);
    if (normalized === normalizePath(currentPath)) {
        return true;
    }

    const segments = normalized.split("/");
    const parent = segments.at(-2) ?? "";
    return segments.at(-1) === STUBS_DIRECTORY
        && parent.startsWith(EXTENSION_DIRECTORY_PREFIX);
}

export function mergeHubOS3StubPath(
    extraPaths: readonly string[],
    stubsPath: string,
    enabled: boolean,
): string[] {
    const merged = extraPaths.filter((value) =>
        !isManagedStubsPath(value, stubsPath));

    if (enabled) {
        merged.push(stubsPath);
    }

    return merged;
}

export function mergeMissingModuleSourceOverride(
    diagnosticOverrides: Readonly<Record<string, string>>,
    enabled: boolean,
    ownsOverride: boolean,
): { diagnosticOverrides: Record<string, string>, ownsOverride: boolean } {
    const merged = { ...diagnosticOverrides };
    const current = merged[MISSING_MODULE_SOURCE_RULE];

    if (enabled && current === undefined) {
        merged[MISSING_MODULE_SOURCE_RULE] = "none";
        return { diagnosticOverrides: merged, ownsOverride: true };
    }

    if (!enabled && ownsOverride) {
        if (current === "none") {
            delete merged[MISSING_MODULE_SOURCE_RULE];
        }
        return { diagnosticOverrides: merged, ownsOverride: false };
    }

    return {
        diagnosticOverrides: merged,
        ownsOverride: ownsOverride && current === "none",
    };
}

export function mergeHubOS3StubPathSetting(
    stubPath: string | undefined,
    currentPath: string,
    enabled: boolean,
    previousPath: string | undefined,
    ownsSetting: boolean,
): { stubPath: string | undefined, previousPath: string | undefined, ownsSetting: boolean } {
    if (enabled) {
        return {
            stubPath: currentPath,
            previousPath: ownsSetting ? previousPath : stubPath,
            ownsSetting: true,
        };
    }

    if (ownsSetting && stubPath && isManagedStubsPath(stubPath, currentPath)) {
        return {
            stubPath: previousPath,
            previousPath: undefined,
            ownsSetting: false,
        };
    }

    return { stubPath, previousPath: undefined, ownsSetting: false };
}

export async function configureHubOS3Stubs(
    context: vscode.ExtensionContext,
): Promise<void> {
    if (context.extensionUri.scheme !== "file" || !vscode.workspace.workspaceFolders?.length) {
        return;
    }

    const enabled = vscode.workspace.getConfiguration().get(ENABLE_SETTING, true);
    const stubsPath = vscode.Uri.joinPath(context.extensionUri, STUBS_DIRECTORY).fsPath;
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const existing = configuration.get<string[]>(EXTRA_PATHS_SETTING, []);
    const merged = mergeHubOS3StubPath(existing, stubsPath, enabled);

    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
        await configuration.update(
            EXTRA_PATHS_SETTING,
            merged,
            vscode.ConfigurationTarget.Workspace,
        );
    }

    const existingStubPath = configuration.inspect<string>(STUB_PATH_SETTING)?.workspaceValue;
    const previousStubPath = context.workspaceState.get<string>(PREVIOUS_STUB_PATH_KEY);
    const ownsStubPath = context.workspaceState.get<boolean>(OWNS_STUB_PATH_KEY, false);
    const stubPathResult = mergeHubOS3StubPathSetting(
        existingStubPath,
        stubsPath,
        enabled,
        previousStubPath,
        ownsStubPath,
    );

    if (existingStubPath !== stubPathResult.stubPath) {
        await configuration.update(
            STUB_PATH_SETTING,
            stubPathResult.stubPath,
            vscode.ConfigurationTarget.Workspace,
        );
    }
    if (previousStubPath !== stubPathResult.previousPath) {
        await context.workspaceState.update(
            PREVIOUS_STUB_PATH_KEY,
            stubPathResult.previousPath,
        );
    }
    if (ownsStubPath !== stubPathResult.ownsSetting) {
        await context.workspaceState.update(
            OWNS_STUB_PATH_KEY,
            stubPathResult.ownsSetting,
        );
    }

    const existingOverrides = configuration.get<Record<string, string>>(
        DIAGNOSTIC_OVERRIDES_SETTING,
        {},
    );
    const ownsOverride = context.workspaceState.get<boolean>(
        OWNS_MISSING_MODULE_OVERRIDE_KEY,
        false,
    );
    const overrideResult = mergeMissingModuleSourceOverride(
        existingOverrides,
        enabled,
        ownsOverride,
    );

    if (JSON.stringify(existingOverrides) !== JSON.stringify(overrideResult.diagnosticOverrides)) {
        await configuration.update(
            DIAGNOSTIC_OVERRIDES_SETTING,
            overrideResult.diagnosticOverrides,
            vscode.ConfigurationTarget.Workspace,
        );
    }
    if (ownsOverride !== overrideResult.ownsOverride) {
        await context.workspaceState.update(
            OWNS_MISSING_MODULE_OVERRIDE_KEY,
            overrideResult.ownsOverride,
        );
    }
}

function updateHubOS3Stubs(context: vscode.ExtensionContext): void {
    void configureHubOS3Stubs(context).catch((error) => {
        console.error("Unable to configure bundled HubOS3 stubs", error);
    });
}

export function registerHubOS3Stubs(context: vscode.ExtensionContext): void {
    updateHubOS3Stubs(context);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(ENABLE_SETTING)) {
            updateHubOS3Stubs(context);
        }
    }));
}