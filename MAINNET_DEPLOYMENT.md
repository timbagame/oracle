# Oracle Service — Mainnet Deployment Guide

Deploy the oracle as a long-running Bun service that listens to mainnet-beta events and signs completions with a dedicated authority.

## Prerequisites

- Bun runtime installed on the target host
- `admin-keypair.json` funded on mainnet (oracle authority)
- Network access to a low-latency Solana RPC endpoint
- Updated IDL placed in `idl/idl.json`

## 1. Prepare Environment

```bash
cd oracle
cp env.example .env
```

Edit `.env` with production values:

```bash
SOLANA_NETWORK=["https://api.mainnet-beta.solana.com","https://rpc-backup.example.com"]
ORACLE_PORT=3001                # optional
ORACLE_KEYPAIR_PATH=./admin-keypair.json
```

`SOLANA_NETWORK` accepts JSON arrays or comma-delimited strings; the oracle automatically advances through the ordered list when encountering retryable RPC errors.

> Ensure `ORACLE_KEYPAIR_PATH` points to the same oracle authority configured during contract deployment.

## 2. Install Dependencies

```bash
bun install
```

## 3. Launch the Service

```bash
bun start
```

For production, wrap the command with a process manager (systemd, pm2, docker, etc.) and redirect logs.

## 4. Validate Health

```bash
curl http://localhost:3001/health
```

Check Bun logs to confirm event listeners attach successfully and no subscription errors occur.

## 5. Ongoing Operations

- Keep the oracle wallet funded to pay for transaction fees.
- Monitor `/stats` to track completions and fallback scans.
- When updating the program IDL, copy the new JSON file into `idl/idl.json` prior to restarting.
