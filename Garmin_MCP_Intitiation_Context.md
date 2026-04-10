# Garmin MCP – Deployment Context

## Ziel

Das Repo `alexanderhetzel/garmin-connect-mcp` (Fork von `Nicolasvegam/garmin-connect-mcp`, 61 Tools) soll als remote HTTP-Server auf Railway laufen und in Claude.ai Web + Mobile als MCP Integration eingebunden werden. Das Repo ist auf Original-Stand (keine Änderungen).

Railway URL: `https://garmin-connect-mcp-production-0559.up.railway.app`
Railway Environment Variables: `GARMIN_EMAIL`, `GARMIN_PASSWORD` gesetzt.
Railway Custom Build Command: `npm install && npm run build`
Railway Port: `8080`

---

## Das Problem

Der Server ist als stdio-MCP gebaut. Claude.ai Web/Mobile braucht einen HTTP-Endpunkt.

### Was versucht wurde: supergateway

`npx supergateway --stdio "node build/index.js"` als Custom Start Command in Railway. Supergateway wrappt den stdio-Prozess als SSE-Server.

**Beobachtung:** SSE-Verbindungen kamen an (sichtbar in Logs), wurden aber sofort wieder geschlossen ohne dass Tool-Calls durchgingen. Außerdem crashed der Prozess bei einer zweiten eingehenden Verbindung mit:

```
Error: Already connected to a transport. Call close() before connecting to a new transport
```

### Was versucht wurde: eigener http-server.ts

Ein `src/http-server.ts` wurde geschrieben der Express + `SSEServerTransport` verwendet und pro Verbindung eine neue `McpServer`-Instanz erstellt. Der Server war online und SSE-Verbindungen kamen an – aber Tool-Calls schlugen trotzdem fehl. Vermutung: Claude.ai verwendet nicht mehr SSE sondern Streamable HTTP (`POST /mcp` statt `GET /sse`). Das wurde nicht mehr verifiziert bevor der Reset.

---

## Bekannte Fallstricke

**package-lock.json sync:** `npm ci` schlägt fehl wenn `package.json` ohne lokales `npm install` geändert wird. Deshalb ist Railway Build Command auf `npm install && npm run build` gesetzt.

**Garmin Rate Limiting:** Die Garmin API ist inoffiziell/reverse-engineered. Shared Railway-IPs können von Garmin geblockt werden (429). Der GarminClient cached Tokens in `~/.garmin-mcp/` um wiederholte Logins zu vermeiden.

**MFA:** Falls Garmin MFA aktiv ist, muss `node build/setup.js` interaktiv ausgeführt werden um Tokens vorab zu generieren. In Railway ist das nicht möglich ohne weiteres.
