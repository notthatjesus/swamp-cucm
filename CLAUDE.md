<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search local types with `swamp model type search <query>`, (b) search community extensions with `swamp extension search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) only create a custom extension model in `extensions/models/` if nothing exists. Use the `swamp-extension-model` skill for guidance. The `command/shell` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp model type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp model get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp model method run` calls against the same model. Multiple parallel calls against the same model contend on the per-model lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp model type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. `deno.lock` and `package.json` do NOT cover extension model dependencies — this is by design. Always pin explicit versions in `npm:` import specifiers (e.g., `npm:lodash-es@4.17.21`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output (security reports, cost analysis, compliance checks, summaries), create a report extension. Use the `swamp-report` skill for guidance.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- `swamp-model` - Work with swamp models (creating, editing, validating)
- `swamp-workflow` - Work with workflows (creating, editing, running)
- `swamp-vault` - Manage secrets and credentials
- `swamp-data` - Manage model data lifecycle
- `swamp-report` - Create and run reports for models and workflows
- `swamp-repo` - Repository management
- `swamp-extension-model` - Create custom TypeScript models
- `swamp-extension-driver` - Create custom execution drivers
- `swamp-extension-datastore` - Create custom datastore backends
- `swamp-extension-vault` - Create custom vault providers
- `swamp-issue` - Submit bug reports and feature requests
- `swamp-troubleshooting` - Debug and diagnose swamp issues

## Getting Started

Always start by using the `swamp-model` skill to work with swamp models.

## Commands

Use `swamp --help` to see available commands.
<!-- END swamp managed section -->

## CUCM Extension

This repo contains a Cisco Unified Communications Manager (CUCM) extension under `@notthatjesus/cisco-unified-communications-manager`. Each resource type is a separate model file in `extensions/models/`.

### Model instances

| Instance name | Type |
|---|---|
| `phone` | `@notthatjesus/cisco-unified-communications-manager/phone` |
| `line` | `@notthatjesus/cisco-unified-communications-manager/line` |
| `user` | `@notthatjesus/cisco-unified-communications-manager/user` |
| `device-profile` | `@notthatjesus/cisco-unified-communications-manager/device-profile` |

**Naming convention:** instance names match the resource type (e.g. `phone`, not `cucm-phone`).

### Credentials

Credentials are stored in vault `cucm-credentials` with keys `username` and `password`. The CUCM host IP is provided by the user when creating a model instance. Always reference credentials via vault expressions:

```yaml
username: '${{ vault.get(cucm-credentials, username) }}'
password: '${{ vault.get(cucm-credentials, password) }}'
```

### Shared implementation patterns

All model files follow the same structure — copy from an existing one rather than starting from scratch:

- **HTTP client:** `npm:undici@5.28.4` with `Agent({ connect: { rejectUnauthorized: false } })` to bypass CUCM self-signed TLS cert
- **XML parser:** `npm:fast-xml-parser@4.5.0` with `removeNSPrefix: true`, `attributeNamePrefix: "@_"`, `textNodeName: "#text"`, `parseAttributeValue: false`
- **`isArray`:** Always declare list response paths explicitly (e.g. `"Envelope.Body.listPhoneResponse.return.phone"`) to ensure single-item responses are still arrays
- **Version discovery:** `discoverVersion()` calls `getCCMVersion` and extracts the major.minor (e.g. `"15.0"`) — used when `version` global arg is omitted
- **FK normalization:** `normalizeFk()` handles `XFkType` fields which parse as either a plain string or `{ "#text": name, "@_uuid": uuid }`
- **Factory pattern for `get`:** instance name = the resource's natural key (device name, userid, pattern@partition)
- **Post-write refresh:** `add*` and `update*` methods always call `get*` after mutation and store the full record

### AXL SOAP notes

- Endpoint: `https://<host>:8443/axl/`
- SOAPAction header: `CUCM:DB ver=<version> <methodName>`
- Nullable FK fields use `xsi:nil="true"` (requires `xmlns:xsi` in envelope)
- `xsd:choice` lookups (name vs uuid) — send only one, never both
