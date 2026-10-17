# Relayo

Librería open source para enviar email/SMS de forma agnóstica del proveedor y **normalizar los eventos de vuelta** (rebotes, quejas, bajas…), más un simulador de entrega de pago (Relayo Sim). No es un CRM.

Contexto completo, roadmap, contratos y ADRs: [docs/contexto.md](docs/contexto.md). Estado: fase 0.

## Repo

- Monorepo pnpm (`packages/*`) + Changesets. Las herramientas (TypeScript, tsup, Vitest) están en la raíz.
- `packages/core` → `@relayo/core`: tipos en `src/types/`, errores en `src/errors.ts`, `createRelayo` en `src/relayo.ts`, `failover()` en `src/failover.ts`, `classifyBounce` en `src/bounce.ts`, driver `memory()` para tests.
- `packages/smtp` → `@relayo/smtp`: driver sobre Nodemailer 10 (trae sus propios tipos; no usar `@types/nodemailer`). Tests contra un `smtp-server` real en proceso.
- `packages/ses` → `@relayo/ses`: SESv2 + eventos por SNS (firma verificada). Normalización en `src/events.ts`, fixtures en `test/fixtures/`.
- La clasificación de rebotes vive en el core (`classifyBounce`); los drivers no deben reinventarla, solo afinarla con datos propios del proveedor.
- Los drivers declaran `@relayo/core` como `peerDependency` (una sola copia, para que `instanceof RelayoError` funcione).
- Cada paquete exporta la condición `@relayo/source` → `src/index.ts`; tsc (`customConditions`) y Vitest la usan para trabajar contra el código fuente sin compilar antes. El build de tipos de tsup la desactiva para no incrustar el core.
- Comandos (desde la raíz): `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm changeset`.

## Convenciones

- Node 20+, TypeScript estricto (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), imports relativos con extensión `.js`.
- Salida dual ESM/CJS con tsup; no añadir dependencias en runtime al core sin motivo.
- Código, identificadores y comentarios en inglés; documentación del proyecto en español.
- El `messageId` lo genera el core y llega al driver en `SendContext`; los drivers deben adjuntarlo al mensaje del proveedor para mapear webhooks.
- Todo evento normalizado conserva el payload original en `raw` y propaga `metadata`.
- Errores: subclases de `RelayoError` con `code` y `retryable` correctos; de eso dependen los reintentos y el failover.
- Reintentos desactivados por defecto en el core (ADR 6).
