# LEGO SPIKE Prime / MINDSTORMS Robot Inventor Extension

This extension helps you connect to the SPIKE Prime or MINDSTORMS Robot Inventor brick and perform various operations on it.

> [!IMPORTANT]  
> Starting with version 2.x of the extension it will work ONLY with HubOS3. If you are running on the legacy HubOS2, please use the 1.x version and disable auto-updates for the extension.

## Features

### Connect to a hub

The extension supports Bluetooth and USB connections. By default, the hub picker searches both transports together and updates as hubs are discovered. Hub names and addresses make it easier to distinguish multiple nearby hubs. The extension can also reconnect to the last hub when VS Code starts.

The status bar shows the current connection state:

![status](images/status.png)

Select the status item to connect, or to disconnect when a hub is already connected. Use **LEGO Hub: Set Hub Name** from the Command Palette to rename the connected hub.

### Run and upload programs

When a Python editor is active and a hub is connected, the editor title provides controls for programs on the hub and for the current file:

![Program controls in the Python editor](images/file-actions.png)

- **Play** runs a program that is **already stored on the hub**. It prompts for the slot to run; it does not upload the current editor file.
- **Stop** terminates the program currently running on the hub.
- **Upload Program** (the refresh symbol) uploads the current Python file. Without a valid slot in a `# LEGO` header, the extension prompts for the destination slot. With a valid header, it uses the declared slot and runs the uploaded program when `autostart` is present.
- **Show Log Terminal** opens the persistent terminal for program output and extension messages.
- **Add File Header** helps create the slot and autostart header described below.

The default keyboard shortcuts apply only while a hub is connected and the active Python file begins with `# LEGO`:

| Shortcut   | Action                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `F5`       | Upload the current file using its header; run it after upload when the header includes `autostart`. |
| `Shift+F5` | Stop the program currently running on the hub.                                                      |

These scoped shortcuts replace the normal Python debug actions only for connected LEGO program files.

Only one upload can run at a time. If the hub disconnects or a request does not complete within 10 seconds, the upload fails and its progress notification closes. After a timeout, reconnect the hub before retrying.

### Live Data

The **LEGO Hub: Live Data** view displays live telemetry from the connected hub: battery level, Bluetooth state, hub orientation, motor positions, and values from color, force, distance, and matrix devices. The dashboard adapts to the available width, supports optional detailed values and raw telemetry, and marks ports without connected devices.

Use the LEGO Hub activity-bar view for a compact vertical layout:

![Live Data in the LEGO Hub activity-bar view](images/live-data-vert.png)

Use the **Open Live Telemetry in Editor** button in the view title for a wider editor panel:

![Live Data in a wide editor panel](images/live-data-horiz.png)

The update rate is controlled by `legoSpikePrimeMindstorms.telemetryInterval`.

### Start a stored program

The **LEGO Hub: Start Program** command runs code that is already stored in the selected hub slot:

![slot-selection](images/slot-selection.png)

### Local modules

Python files referenced by `import` and `from ... import ...` statements are automatically uploaded when a matching `.py` file exists beside the importing file or in one of its parent directories up to the project root. The nearest match is used. Local modules are uploaded as separate files and are scanned recursively for their own local imports. Missing modules are left for HubOS to resolve.

When `compileBeforeUpload` is enabled, automatically discovered and explicitly included `.py` files are compiled and uploaded as `.mpy` modules. Other explicitly included file types are uploaded unchanged.

This behavior is supported by both the desktop and web extensions.

### Custom Preprocessor

The plugin has a settings where you can specify an external program/script that should be executed before uploading the program
to the hub. This will receive the contents of the file as stdin. It should output the resulting file contents to stdout and exit the process with `0`.

The custom preprocessor runs immediately before compiling and uploading the main program. Automatically discovered local modules are uploaded separately and are not passed through the custom preprocessor.

If the preprocessor cannot start, exits unsuccessfully, or runs longer than 30 seconds, the upload fails and its progress notification closes. A timed-out preprocessor is terminated.

> [!NOTE]  
> This is not supported for web extension usage.

### Raw Message Logging

For protocol debugging and test capture, enable `legoSpikePrimeMindstorms.logRawMessagesToFile` and reload the extension. The LEGO Hub terminal reports the generated `.jsonl` file in the extension log directory. Each line contains an ISO timestamp, direction (`in` or `out`), transport, and the complete COBS frame as hexadecimal data.

### Compilation

The extension supports compiling Python files to binary (MPY) before uploading. This is controlled by a setting:
![compile-option](images/compile-option.png)

### HubOS3 IntelliSense

The extension installs Pylance and configures its bundled HubOS3 type stubs for Python autocomplete, signatures, hover information, and import checking. No Python package or virtual environment is required. Set `legoSpikePrimeMindstorms.enableHubOS3Stubs` to `false` to disable this integration.

This feature requires the desktop extension host because Pylance cannot index extension files through a browser URI.

## Automatic upload/start of a Python file

During active development, you can avoid repeated slot and autostart prompts by placing a LEGO header on the first line of the file:

```python
# LEGO slot:<0-19> [include:<filename>,<filename>] [autostart]
```

For example, this uploads the current file to slot 5 and starts it after the upload completes:

```python
# LEGO slot:5 autostart
```

Use `include:` to copy files from the program's directory or one of its parent directories up to the project root into the same hub slot as separate modules:

```python
# LEGO include:gadget.py,helpers.py slot:5 autostart
```

The target slot is cleared before each upload, so files from an earlier upload are removed. Explicitly included and automatically discovered files are uploaded separately and are not combined into `program.py`.

Without `autostart`, **Upload Program** uploads the file to the declared slot but does not run it. The header must begin at the first character of the first line and uses uppercase `LEGO`.

To upload a collection of programs, right-click a folder in the Explorer and select **LEGO: Upload All**. The extension recursively finds Python files with LEGO headers, verifies that each has a valid unique slot, and uploads every program with its included files. Batch uploads do not start programs marked `autostart`.

## Credits

Thanks to [Peter Staev](https://github.com/PeterStaev), the original author of this extension, and to [pablomatisch](https://github.com/Pablomatisch) for the initial live telemetry support.

Thanks to LEGO Group to publish [extensive docs](https://lego.github.io/spike-prime-docs/index.html) on how to work with the HubOS protocol.

The bundled HubOS3 type stubs are adapted from [spike3-stubs](https://github.com/Pablomatisch/spike-prime-v3-stubs) by pablomatisch and cross-checked against [LEGO SPIKE Python v3 docs](https://github.com/jvolkening/lego-spike-python-v3-docs) by Jeremy Volkening. Both sources and the official LEGO Education API documentation are credited in [python-stubs/NOTICE.md](python-stubs/NOTICE.md).

## Disclaimer

_LEGO and MINDSTORMS are registered trademarks of the LEGO Group. SPIKE is trademark of LEGO Group._
