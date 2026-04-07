# tokrepo

The official CLI for [TokRepo](https://tokrepo.com) — an open registry for AI assets.

Search, install, publish, and sync reusable AI skills, prompts, MCP configs, scripts, and workflows from the command line.

[![npm version](https://img.shields.io/npm/v/tokrepo.svg)](https://www.npmjs.com/package/tokrepo)
[![license](https://img.shields.io/npm/l/tokrepo.svg)](https://github.com/henu-wang/tokrepo-cli/blob/main/LICENSE)

## Quick Start

```bash
# Search for assets
npx tokrepo search "cursor rules"

# Install an asset into your project
npx tokrepo install awesome-cursor-rules

# Or install globally
npm install -g tokrepo
tokrepo search "mcp server"
```

## Install

```bash
npm install -g tokrepo
```

Requires Node.js >= 16. Zero dependencies.

## Commands

### Discover & Install

| Command | Description |
|---------|-------------|
| `tokrepo search <query>` | Search assets by keyword |
| `tokrepo install <name\|uuid>` | Smart install — auto-detects asset type and places files correctly |
| `tokrepo pull <url\|uuid>` | Download raw asset files to current directory |

### Publish & Sync

| Command | Description |
|---------|-------------|
| `tokrepo push [files...]` | Push files or directory as a new asset |
| `tokrepo sync [dir]` | Sync a directory to TokRepo (smart upsert — creates or updates) |
| `tokrepo status [dir]` | Show diff between local files and remote assets |
| `tokrepo init` | Create a `.tokrepo.json` project config |
| `tokrepo update <uuid> [file]` | Update an existing asset by UUID |
| `tokrepo delete <uuid>` | Delete an asset (with confirmation) |

### Account

| Command | Description |
|---------|-------------|
| `tokrepo login` | Save your API token |
| `tokrepo list` | List your published assets |
| `tokrepo tags` | List available tags |
| `tokrepo whoami` | Show current user |

## Usage Examples

### Search and install

```bash
# Search by keyword
tokrepo search "code review"

#  12 results:
#
#   1. Code Review Skill for Claude
#      claude-code, skill  ★12 👁340
#      tokrepo install ca000374-f5d8-4d75-a30c-460fda0b6b0e

# Install by name (fuzzy match) or UUID
tokrepo install code-review-skill
tokrepo install ca000374-f5d8-4d75-a30c-460fda0b6b0e
```

The `install` command auto-detects the asset type and places files in the right location:

- **Skills** → `.claude/commands/` or project root
- **MCP configs** → merged into your MCP settings
- **Prompts** → `.cursorrules`, `AGENTS.md`, or project root
- **Scripts** → project root (executable permissions set)

### Publish your own assets

```bash
# Login first
tokrepo login
# Paste your API token from https://tokrepo.com/en/workflows/submit

# Push a single file
tokrepo push my-skill.md --public

# Push a directory (all supported files)
tokrepo push --public .

# Sync — creates new assets or updates existing ones
tokrepo sync .
```

### Check sync status

```bash
tokrepo status .

# ┌ tokrepo status
# │
# │  Modified:
# │    my-skill.md (local changes)
# │
# │  New (not yet pushed):
# │    new-prompt.md
# │
# └ 1 modified, 1 new
```

## Supported Asset Types

| Type | Extensions |
|------|-----------|
| Skills | `.skill.md` |
| Prompts | `.prompt`, `.prompt.md` |
| Configs | `.json`, `.yaml`, `.yml`, `.toml`, `.mcp.json`, `.cursorrules`, `.claude.md` |
| Scripts | `.sh`, `.py`, `.js`, `.ts`, `.mjs`, `.go`, `.rs`, `.rb`, `.lua` |
| Docs | `.md` |

## Configuration

Config is stored in `~/.tokrepo/config.json` (created on `tokrepo login`).

```json
{
  "token": "tk_your_api_token",
  "api": "https://api.tokrepo.com"
}
```

Per-project config can be set in `.tokrepo.json`:

```json
{
  "defaultTags": ["claude-code", "productivity"],
  "defaultVisibility": "public"
}
```

## Security

- API tokens are stored with `0600` permissions (owner-only read/write)
- Config directory uses `0700` permissions
- HTTPS is enforced for all API requests — the CLI will refuse to send tokens over plain HTTP
- No telemetry, no tracking, no analytics

## Related

- [tokrepo.com](https://tokrepo.com) — Web interface
- [tokrepo-mcp-server](https://github.com/henu-wang/tokrepo-mcp-server) — MCP server for AI-native access
- [tokrepo-search-skill](https://github.com/henu-wang/tokrepo-search-skill) — Cross-platform search skill
- [tokrepo](https://github.com/henu-wang/tokrepo) — Project overview

## License

MIT
