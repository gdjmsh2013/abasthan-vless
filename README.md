# abasthan-vless

VLESS + WebSocket node for Abasthan, reached through a Cloudflare Tunnel.

The Node launcher (`index.js`) downloads Xray-core on first start and runs
it with a VLESS+WS inbound on port 5000 (the tunnel target) and on the
platform-provided `PORT` when different. When `ARGO_TOKEN` is set it also
downloads and supervises cloudflared (forced HTTP/2, edge IPs resolved via
1.1.1.1, health-checked every minute).

## Environment variables

- `UUID` (required, secret): the VLESS user id. Never commit it.
- `ARGO_TOKEN` (secret): Cloudflare Tunnel token.
- `WS_PATH` (optional, default `/ws`).
- `PORT` is provided by the platform.

## Start command

`npm start`
