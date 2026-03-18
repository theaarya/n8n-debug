# n8n API

You have access to the n8n instance at `n8n.tutero.dev` via `n8n.ts`. Run it with `npx tsx n8n.ts`.

## Usage

```
npx tsx n8n.ts <domain>.<action> '{json params}'
```

## Domains & Actions

### Health
| Command | Description |
|---|---|
| `health` | Check instance connectivity |

### Workflows
| Command | Params |
|---|---|
| `workflows.list` | `{"limit?","cursor?","active?","tags?"}` |
| `workflows.get` | `{"id"}` |
| `workflows.create` | `{"name","nodes","connections","settings?"}` |
| `workflows.update` | `{"id","name?","nodes?","connections?","settings?"}` |
| `workflows.delete` | `{"id"}` |
| `workflows.activate` | `{"id"}` |
| `workflows.deactivate` | `{"id"}` |
| `workflows.trigger` | `{"id","path?","method?","data?","headers?"}` |
| `workflows.test` | `{"id","path?","method?","data?"}` (uses /webhook-test/) |

### Executions
| Command | Params |
|---|---|
| `executions.list` | `{"workflowId?","status?","limit?","cursor?"}` |
| `executions.get` | `{"id","includeData?"}` |
| `executions.delete` | `{"id"}` |

### Credentials
| Command | Params |
|---|---|
| `credentials.list` | `{"limit?","cursor?"}` |
| `credentials.create` | `{"name","type","data"}` |
| `credentials.delete` | `{"id"}` |

### Tags
| Command | Params |
|---|---|
| `tags.list` | `{"limit?","cursor?"}` |
| `tags.create` | `{"name"}` |

### Templates (from n8n.io — no auth needed)
| Command | Params |
|---|---|
| `templates.search` | `{"query?","limit?","category?"}` |
| `templates.get` | `{"templateId"}` |
| `templates.deploy` | `{"templateId","name?"}` (fetches + creates on instance) |

## Workflow Discovery

```bash
# List all workflows
npx tsx n8n.ts workflows.list

# Find by name (pipe through jq)
npx tsx n8n.ts workflows.list | jq '.data[] | select(.name | test("stripe";"i")) | {id,name,active}'

# Get full workflow with nodes
npx tsx n8n.ts workflows.get '{"id":"17YDxoYZ4AOIsDEo"}'

# Check recent failures
npx tsx n8n.ts executions.list '{"status":"error","limit":5}'
```

## Triggering Workflows

Two modes depending on whether the workflow is active:

```bash
# Active workflow (production webhook)
npx tsx n8n.ts workflows.trigger '{"id":"abc","data":{"key":"value"}}'

# Inactive workflow (test webhook — must be listening in n8n UI)
npx tsx n8n.ts workflows.test '{"id":"abc","data":{"key":"value"}}'
```

Both auto-detect the webhook path from the workflow's trigger node. Override with `"path":"custom-path"`.

## Node Configuration

n8n nodes follow this structure:
```json
{
  "id": "unique-id",
  "name": "Human-readable name",
  "type": "nodes-base.httpRequest",
  "typeVersion": 4,
  "position": [250, 300],
  "parameters": {
    "method": "POST",
    "url": "https://api.example.com/data",
    "sendBody": true,
    "bodyParameters": {
      "parameters": [{"name": "key", "value": "={{ $json.field }}"}]
    }
  }
}
```

Common node types:
- `n8n-nodes-base.webhook` — HTTP trigger
- `n8n-nodes-base.httpRequest` — Make HTTP calls
- `n8n-nodes-base.code` — Custom JS/Python
- `n8n-nodes-base.if` — Conditional branching
- `n8n-nodes-base.set` — Set/transform fields
- `n8n-nodes-base.merge` — Merge branches
- `n8n-nodes-base.splitInBatches` — Loop over items
- `n8n-nodes-base.noOp` — No operation (pass-through)
- `n8n-nodes-base.respondToWebhook` — Send webhook response

Expression syntax: `={{ $json.fieldName }}` or `={{ $('Node Name').item.json.field }}`

## Connections Format

Keys are source node names. Values define which output connects to which input:
```json
{
  "Webhook": {
    "main": [[{"node": "HTTP Request", "type": "main", "index": 0}]]
  },
  "HTTP Request": {
    "main": [[{"node": "Respond to Webhook", "type": "main", "index": 0}]]
  }
}
```

## Templates

Search n8n.io's public library and deploy directly:
```bash
# Search
npx tsx n8n.ts templates.search '{"query":"slack webhook","limit":5}'

# Get template details
npx tsx n8n.ts templates.get '{"templateId":1234}'

# Deploy to your instance (creates inactive workflow)
npx tsx n8n.ts templates.deploy '{"templateId":1234,"name":"My Workflow"}'
```

## Batch Operations

```bash
npx tsx -e '
  const { n8n } = require("./n8n");
  const { data: workflows } = await n8n("workflows.list");
  const inactive = workflows.filter(w => !w.active);
  console.log(`${inactive.length} inactive workflows`);
  for (const w of inactive) {
    console.log(`  ${w.id}: ${w.name}`);
  }
'
```
