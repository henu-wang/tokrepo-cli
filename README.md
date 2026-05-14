# TokRepo CLI

Agent-native CLI for discovering, installing, and publishing reusable AI assets: skills, prompts, MCP configs, scripts, workflows, and project instructions.

## Agent Bootstrap

Run this once in any repository that will be touched by coding agents:

```bash
npx -y tokrepo@latest init-agent --target all
```

It writes a managed TokRepo block into the project memory files that agents already read:
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/tokrepo.mdc`,
`.github/copilot-instructions.md`, `.github/instructions/tokrepo.instructions.md`,
`.clinerules/tokrepo.md`, `.windsurf/rules/tokrepo.md`, `.roo/rules/tokrepo.md`,
`.openhands/microagents/repo.md`, `CONVENTIONS.md`, and `.mcp.json`.
Future agents get a local rule to call `tokrepo_discover` during planning instead of inventing a one-off local helper first.

## Planning-Time Discovery

For agents without MCP access:

```bash
npx -y tokrepo@latest agent-check "audit this Nuxt app for SEO gaps" --json
```

For MCP clients:

```bash
npx -y tokrepo-mcp-server
```

Then call `tokrepo_discover`, inspect with `tokrepo_detail`, and call `tokrepo_install_plan` before writing files or activating assets.

## Post-Task Handoff

After an agent creates reusable instructions, scripts, prompts, or configs:

```bash
npx -y tokrepo@latest agent-handoff --json
```

This only suggests private `tokrepo push` commands. It never publishes automatically.

## Common Commands

```bash
tokrepo search "code review skill" --kind skill --policy allow --json
tokrepo detail <uuid> --json
tokrepo plan <uuid> --target codex
tokrepo install <uuid> --target codex --dry-run --json
tokrepo installed --target codex --json
tokrepo push . --private --kind skill --target codex --install-mode bundle
```

## Machine-Readable Discovery

- Manifest: https://tokrepo.com/.well-known/tokrepo.json
- MCP server manifest: https://tokrepo.com/.well-known/mcp/server.json
- Portable agent manifest: https://tokrepo.com/.well-known/agent.json
- A2A agent card: https://tokrepo.com/.well-known/agent-card.json
- Tool catalog: https://tokrepo.com/.well-known/tool-catalog.json
- Agent instructions: https://tokrepo.com/agent-instructions/tokrepo.md
- Agent text entry: https://tokrepo.com/agents.txt
- LLM crawler entry: https://tokrepo.com/llms.txt

TokRepo records anonymous aggregate funnel events for agent discovery, plan, install, handoff, and push. It does not send task text or file contents. Disable with `TOKREPO_TELEMETRY=0`.
