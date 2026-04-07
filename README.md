# @notthatjesus/cisco-unified-communications-manager

Cisco Unified Communications Manager (CUCM) automation for [Swamp](https://swamp.club) via the AXL SOAP API. Manage phones, directory numbers, end users, and device profiles. Works with CUCM 10.0+ via the on-premises call control API.

## Models

| Model | Description |
|---|---|
| phone | Phone inventory, provisioning, line associations, and device configuration |
| line | Directory number (DN) lifecycle, partitions, and call pickup groups |
| user | End user administration, CTI control permissions, and phone associations |
| device-profile | Extension Mobility profiles and device template configuration |

### phone

| Method | Description |
|---|---|
| list | List all phones with optional filter by device pool, protocol, or device type |
| get | Get phone details by device name |
| add | Provision a new phone with protocol, product, and line associations |
| update | Modify phone configuration, lines, or device pool |
| remove | Delete a phone from CUCM |

### line

| Method | Description |
|---|---|
| list | List directory numbers with filter by partition or route partition |
| get | Get DN details by pattern and partition |
| add | Create a new directory number |
| update | Modify DN settings, call forwarding, or pickup group |
| remove | Delete a directory number |

### user

| Method | Description |
|---|---|
| list | List end users with filter by department or presence group |
| get | Get user details by userid |
| add | Create a new end user with credentials and groups |
| update | Modify user attributes, associations, or CTI settings |
| remove | Delete an end user |

### device-profile

| Method | Description |
|---|---|
| list | List device profiles (Extension Mobility templates) |
| get | Get profile by name |
| add | Create a device profile for Extension Mobility |
| update | Modify profile configuration |
| remove | Delete a device profile |

## Installation

```bash
swamp extension pull @notthatjesus/cisco-unified-communications-manager
```

## Setup

1. **Create a vault** for CUCM credentials:

```bash
swamp vault create cucm-credentials --type local_encryption
swamp vault set cucm-credentials username <your-axl-username>
swamp vault set cucm-credentials password <your-axl-password>
```

2. **Create model instances** (example for phone):

```bash
swamp model create --type @notthatjesus/cisco-unified-communications-manager/phone --name phone
```

When prompted:
- `host`: Your CUCM IP or hostname
- `username`: `${{ vault.get(cucm-credentials, username) }}`
- `password`: `${{ vault.get(cucm-credentials, password) }}`
- `version`: Auto-detected if omitted (calls `getCCMVersion`)

3. **Test connectivity**:

```bash
swamp model method run --model phone --method list
```

## API Compatibility

- **Protocol**: SOAP over HTTPS (AXL API)
- **Endpoint**: `https://<host>:8443/axl/`
- **CUCM Versions**: 10.0+ (auto-discovers version if not specified)
- **TLS**: Accepts self-signed certificates (standard for CUCM deployments)

## License

MIT
