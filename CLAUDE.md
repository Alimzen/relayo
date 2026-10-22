# Relayo

Librería open source para enviar email/SMS de forma agnóstica del proveedor y **normalizar los eventos de vuelta** (rebotes, quejas, bajas…), más un simulador de entrega de pago (Relayo Sim). No es un CRM.

Contexto completo, roadmap, contratos y ADRs: [docs/contexto.md](docs/contexto.md). Estado: fases 0, 1 y 2 hechas (Relayo Sim en el repo privado `relayo-sim`); fase 3 en curso (falta dominio y despliegue, freemium y beta).

## Repo

- Monorepo pnpm (`packages/*`) + Changesets. Las herramientas (TypeScript, tsup, Vitest) están en la raíz.
- `packages/core` → `@alimzen/relayo`: tipos en `src/types/`, errores en `src/errors.ts`, `createRelayo` en `src/relayo.ts`, `failover()` en `src/failover.ts`, `classifyBounce` en `src/bounce.ts`, driver `memory()` para tests.
- `packages/smtp` → `@alimzen/relayo-smtp`: driver sobre Nodemailer 10 (trae sus propios tipos; no usar `@types/nodemailer`). Tests contra un `smtp-server` real en proceso.
- `packages/ses` → `@alimzen/relayo-ses`: SESv2 + eventos por SNS (firma verificada). Normalización en `src/events.ts`, fixtures en `test/fixtures/`.
- `packages/sendgrid` → `@alimzen/relayo-sendgrid`: API v3 con `fetch` (sin SDK), Event Webhook firmado (ECDSA, necesita `rawBody`). Normalización en `src/events.ts`.
- `packages/resend`, `packages/postmark`, `packages/mailgun` → drivers con `fetch` y sin dependencias. Resend: id y `metadata` en tags (metadata en base64url, ≤256), firma Svix, `Idempotency-Key`. Postmark: `Metadata` nativo, sin firma (basic auth), un solo tag. Mailgun: `v:` user-variables, form-data, firma HMAC en el cuerpo, máximo 3 tags. Formatos verificados en la documentación oficial (octubre 2026); fixtures construidos a partir de ella.
- `packages/simulator` → `@alimzen/relayo-simulator`: driver de Relayo Sim (API HTTP + webhooks firmados `t=..,v1=HMAC`), `scenarioAddress()`. `baseUrl` obligatorio (no hay host por defecto al que mandar la API key). El simulador vive en el repo privado `relayo-sim`.
- `packages/twilio` → `@alimzen/relayo-twilio`: SMS por la API de Twilio (form-encoded, un mensaje por destinatario). El id de Relayo viaja en la query del `statusCallback` (`relayo_message_id`); la firma `X-Twilio-Signature` cubre la URL completa, que llega en `WebhookRequest.url`.
- `packages/cloud` → `@alimzen/relayo-cloud`: `relayoCloud()` / `relayoCloudSms()`, el driver del simulador con `baseUrl` por defecto `https://relayo.alimzen.com` y nombre `relayo`. Las claves `rly_test_` simulan y las `rly_live_` entregan por las conexiones del proyecto (lógica en `relayo-sim/src/live`).
- `packages/nestjs` → `@alimzen/relayo-nestjs`: `RelayoModule`, `RelayoService`, `@OnRelayoEvent`, controlador de webhooks opcional. Peer `^11 || ^12` de NestJS (la 12 es solo ESM). Usar siempre `@Inject(token)` explícito: esbuild no emite metadata de decoradores.
- `packages/bounces` → `@alimzen/relayo-bounces`: `parseBounceEmail(raw)` convierte DSN (RFC 3464), ARF (RFC 5965) y rebotes no estándar con `X-Failed-Recipients` en eventos; ignora respuestas automáticas. Parser MIME propio mínimo, sin dependencias. Fixtures `.eml` en `test/fixtures/` (marcados `-text` para conservar CRLF).
- `packages/imap` → `@alimzen/relayo-imap`: `bounceMailbox()` lee el buzón de rebotes con ImapFlow 2 y emite los eventos de `@alimzen/relayo-bounces` (entrega al menos una vez: marca el mensaje solo si el handler terminó). Tests contra `hoodiecrow-imap`, un servidor IMAP en memoria.
- `packages/cli` → `@alimzen/relayo-cli`, comando `relayo` (npm rechaza el nombre `relayo` sin scope por parecido con `delay`): CLI de Relayo Sim (`scenarios`, `send`, `messages`, `show`, `wait`, `report`), sin dependencias, solo ESM con `bin`. Lógica en `src/run.ts` (`run(argv, io)`, testeable con `fetch`, reloj y `sleep` falsos). Códigos de salida: 0 ok, 1 expectativa no cumplida, 2 uso, 3 API.
- `actions/sim` → GitHub Action compuesta (`step: start | report`) que ejecuta la CLI con `npx @alimzen/relayo-cli@<cli-version>`. Las entradas pasan por `env`, nunca interpoladas en el script.
- Los errores del core se reconocen entre copias del paquete por marca (`Symbol.for`) y `static code`; toda subclase nueva de `RelayoError` debe declarar `static readonly code`.
- La clasificación de rebotes vive en el core (`classifyBounce`); los drivers no deben reinventarla, solo afinarla con datos propios del proveedor.
- Los drivers declaran `@alimzen/relayo` como `peerDependency` con el rango explícito `>=0.1.0 <1.0.0` (no `workspace:^`: haría que Changesets publicara los drivers como major) y como `devDependency` `workspace:^` para el enlace local. Un changeset que rompa el contrato del core debe incluir también los drivers afectados.
- Cada paquete exporta la condición `@alimzen/source` → `src/index.ts`; tsc (`customConditions`) y Vitest la usan para trabajar contra el código fuente sin compilar antes. El build de tipos de tsup la desactiva para no incrustar el core.
- Comandos (desde la raíz): `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm changeset`.

## Convenciones

- Node 20+, TypeScript estricto (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), imports relativos con extensión `.js`.
- Salida dual ESM/CJS con tsup; no añadir dependencias en runtime al core sin motivo.
- Código, identificadores y comentarios en inglés; documentación del proyecto en español.
- El `messageId` lo genera el core y llega al driver en `SendContext`; los drivers deben adjuntarlo al mensaje del proveedor para mapear webhooks.
- Todo evento normalizado conserva el payload original en `raw` y propaga `metadata`.
- Errores: subclases de `RelayoError` con `code` y `retryable` correctos; de eso dependen los reintentos y el failover.
- Reintentos desactivados por defecto en el core (ADR 6).
