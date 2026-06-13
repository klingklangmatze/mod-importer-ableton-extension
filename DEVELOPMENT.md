# Development notes

## Project layout

```text
src/                 Extension source
scripts/             Dependency checks used by package scripts
vendor/              Ableton SDK and CLI tarballs for reproducible local installs
README.md            User-facing install and usage notes
MOD_EFFECTS.md       MOD effect handling reference
DEVELOPMENT.md       Development and packaging notes
```

## Packaging

Run:

```bash
npm run package
```

Do not commit generated outputs:

```text
node_modules/
dist/
*.ablx
package-lock.json
```

## SDK usage policy

The extension uses the public Ableton Extensions SDK beta API only:

- `ui.showModalDialog` for the HTML Webview dialog.
- `ui.withinProgressDialog` for progress reporting and cancellation support.
- `commands.registerCommand` and context-menu registration for launching the importer.
- `song.createMidiTrack`, `song.deleteTrack`, and cue-point creation for set changes.
- `MidiClip.notes` for MIDI note output.
- native device insertion and `DeviceParameter.setValue` for Simpler and Drum Rack setup.

The current SDK is not used for unsupported features such as MIDI pitch bend, MIDI CC, clip automation, Group Track creation, or track-header colors. These features are not assumed or emulated through private APIs.

## Logging policy

The Extension Host records `console.info`, `console.warn`, and `console.error` output in `ExtensionHost.txt`. Use logging for activation, warnings, and failures only. Do not log routine import data, full private file paths, downloaded module contents, or large reports.

Errors should be visible to the user in the dialog and also written to the host log with private home paths sanitized where possible.
