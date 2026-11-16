# abasthan-vless

VLESS + WebSocket node for Abasthan.

The Node launcher (`index.js`) downloads Xray-core on first start and runs
it on an internal port (127.0.0.1:5001). A small built-in front proxy
listens on the public ports (5000, 9400, and the platform-provided `PORT`
when different): it answers health checks with `200 ok` and relays the
WebSocket path to Xray (plain HTTP and Upgrade). When `ARGO_TOKEN` is set
it also downloads and supervises cloudflared (forced HTTP/2, edge IPs
resolved via 1.1.1.1, health-checked every minute).

Note: Abasthan free instances appear to block outbound TCP/UDP port 7844
(cloudflared's precheck hard-fails), so the Cloudflare Tunnel may never
register there; the node is then reached directly through the app's
abasthan.app subdomain instead.

## Environment variables

- `UUID` (required, secret): the VLESS user id. Never commit it.
- `ARGO_TOKEN` (secret): Cloudflare Tunnel token.
- `WS_PATH` (optional, default `/ws`).
- `PORT` is provided by the platform.

## Start command

`npm start`
