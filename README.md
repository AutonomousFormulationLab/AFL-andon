# AFL Andon

This Electron application provides a cross‑platform control panel for managing
remote servers.  Each server is defined in a JSON configuration file.  The app
can start, stop and restart screen sessions over SSH, display their current
status and open their web interfaces.  A built‑in terminal allows joining a
running session for interactive commands.

## Features

- Visual dashboard with per‑server status indicators
- Start, stop and restart servers via SSH
- View recent logs and join screen sessions in an integrated terminal
- Batch status updates per host to reduce SSH connections
- Add, edit or remove servers stored in `launchers.json`
- Import configuration and SSH key files and set their paths
- Edit local or remote AFL settings using a JSON editor
- Webview tabs for interacting with each server’s web UI
- Optional device server mode for simple up/down checks

## Prerequisites

- **Node.js 20** or newer is required. Install via [nvm](https://github.com/nvm-sh/nvm) or your
  preferred method.

## Installation

Install dependencies and audit them for security issues:

```bash
npm install
npm audit fix
```

If additional issues remain after running `npm audit fix`, review the log and
update the affected packages.

## Running

Start the application with:

```bash
npm start
```

For development with debugging enabled use:

```bash
npm run dev
```

## Configuration Paths

By default the app uses `~/.afl/launchers.json` for server definitions and
`~/.ssh/id_rsa` as the SSH key.  These paths can be overridden with the
`SERVER_CONTROL_CONFIG_PATH` and `SERVER_CONTROL_SSH_KEY_PATH` environment
variables or via `--config` and `--ssh-key` command‑line options.  The
Settings tab also provides buttons to change them at runtime.

## Building

Builds for your current platform can be created with:

```bash
npm run build
```

See `package.json` for platform-specific build scripts.
The CI workflow produces installers for each OS:
* macOS: DMG
* Linux: AppImage
* Windows: NSIS exe
