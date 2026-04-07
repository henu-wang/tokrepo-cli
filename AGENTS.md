# TokRepo CLI

TokRepo CLI is the command-line tool for TokRepo, an open registry for AI assets (skills, prompts, MCP configs, scripts, workflows).

## Installation

```bash
npm install -g tokrepo
```

## Key Commands

- `tokrepo search <query>` — find assets by keyword
- `tokrepo install <name|uuid>` — install an asset into the current project
- `tokrepo push [files...] --public` — publish files as a new asset
- `tokrepo sync [dir]` — sync a directory (create or update assets)

## API

Base URL: `https://api.tokrepo.com`

- `GET /api/v1/tokenboard/workflows/list?keyword=<query>&page=1&page_size=20` — search assets
- `GET /api/v1/tokenboard/workflows/detail?uuid=<uuid>` — get asset details
- Any asset URL with `Accept: text/plain` header returns raw installable content
