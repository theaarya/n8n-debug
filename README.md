# n8n-debug

Debug tools for n8n workflows: an API script, a Claude skill, and a debug UI.

## Setup

Clone the repo, then tell Claude:

```
Move n8n.md to .claude/commands/n8n.md so it's available as the /n8n skill.
Open debug-ui.html in the browser to use the debug UI.
```

## Files

- **n8n.ts** — n8n REST API script. Run with `npx tsx n8n.ts <domain>.<action> '{"param":"value"}'`
- **n8n.md** — Claude skill for the `/n8n` command (must live at `.claude/commands/n8n.md`)
- **debug-ui.html** — Browser-based debug UI for n8n workflows

## Environment

Set these env vars:

```
N8N_API_KEY=your-api-key
N8N_API_URL=https://your-n8n-instance.com  # defaults to https://n8n.tutero.dev
```
