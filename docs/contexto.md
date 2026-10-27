# Relayo — Contexto del proyecto

## Visión

Relayo es un ecosistema para enviar y probar mensajes (email y SMS, luego WhatsApp, push y Telegram) de forma agnóstica del proveedor.

Tiene dos piezas centrales que se complementan:

1. **Librería open source tipo "ORM de mensajería"**: el desarrollador escribe `relayo.email.send()` una sola vez y por debajo puede usar SES, SendGrid, Mailgun, SMTP, Twilio, etc., igual que TypeORM abstrae la base de datos. Su verdadero valor no es el envío (fácil en todos los proveedores) sino **normalizar lo que vuelve**: rebotes, quejas, bajas y demás eventos llegan con formatos distintos en cada proveedor y Relayo los unifica.
2. **Relayo Sim (SaaS de pago)**: simulador de escenarios de entrega. La app envía a un destino controlado que responde como el mundo real (rebote duro, buzón lleno, bloqueo, greylisting, queja de spam, retraso, etc.) para probar que el sistema reacciona bien. Dentro de la librería es simplemente un driver más (`simulator`).

Modelo de negocio: la librería gratuita genera adopción; el simulador alojado genera ingresos (freemium para desarrolladores, planes de pago para equipos con escenarios avanzados, modo caos, integración CI y retención de logs).

Posicionamiento: suite de herramientas de mensajería para desarrolladores. **No es un CRM.**

## Nombres

| Pieza | Nombre |
| --- | --- |
| Librería core | `@alimzen/relayo` |
| Drivers | `@alimzen/relayo-ses`, `@alimzen/relayo-sendgrid`, `@alimzen/relayo-smtp`, `@alimzen/relayo-twilio` |
| Módulo NestJS | `@alimzen/relayo-nestjs` |
| Simulador (SaaS) | Relayo Sim |
| Bandeja de captura | Relayo Inbox |
| Simulador de flujos | Relayo Flows |
| CLI | comando `relayo`, paquete `@alimzen/relayo-cli` |

Los paquetes se publican bajo el scope **`@alimzen`** (org de npm `alimzen`, repo `github.com/Alimzen/relayo`): el scope `@relayo` de npm pertenece a otra persona. El producto y la API siguen llamándose Relayo. Hasta octubre de 2026 los paquetes se llamaban `@alimzen/core`, `@alimzen/smtp`…; se renombraron a `@alimzen/relayo` y `@alimzen/relayo-*` porque el scope `@alimzen` también tiene otras librerías (auth…) y `core` era ambiguo. Los nombres viejos quedan marcados como obsoletos en npm y no se reutilizan. npm no deja publicar `relayo` sin scope (lo rechaza por parecido con `delay`), así que la CLI es `@alimzen/relayo-cli` y su comando, `relayo`.

Pendiente: dominio (`relayo.dev` / `relayo.io`) y revisar registro de marca.

## Roadmap

| Fase | Contenido | Tiempo estimado (medio tiempo) |
| --- | --- | --- |
| 0 · Validación y diseño | Entrevistas, modelo de mensaje, taxonomía de eventos y errores, interfaz de drivers, ADRs | Semanas 1–3 |
| 1 · Librería core (OSS) | Core, drivers SMTP/SES/SendGrid, normalización de webhooks, módulo NestJS, docs, publicación npm | Semanas 4–9 |
| 2 · Simulador MVP | Servidor SMTP propio, 8–10 escenarios, direcciones mágicas y cabeceras, motor de eventos asíncronos con colas, webhooks, driver `simulator`, panel Angular con línea de tiempo por correo | Semanas 10–17 |
| 3 · Sandbox y beta | Bandeja de captura, CLI / GitHub Action, landing, freemium, usuarios beta | Semanas 18–21 |
| 4 · Más drivers y SMS | Mailgun, Postmark, Resend, Twilio; failover y enrutamiento; modo caos; emulación de APIs de proveedores | Meses 6–8 |
| 5 · Suite avanzada | Simulador de flujos, personas con IA, WhatsApp/push; phishing solo como línea aparte | Mes 9+ |

Hito de validación del negocio: al final de la fase 3, los usuarios beta integran el simulador en su CI y lo siguen usando.

**Estado actual:** fases 0, 1 y 2 completas. Librería publicada en npm como `@alimzen/*`. Relayo Sim (repo `relayo-sim`, open source con AGPL-3.0; la landing y las páginas legales de relayo.alimzen.com, en el privado `relayo-site`): motor de escenarios, SMTP y API, webhooks firmados, PostgreSQL y BullMQ, informes DSN/ARF por correo y panel Angular, probados de punta a punta con la librería. Fase 3 en curso: hechos la bandeja de captura (correo completo con vista previa, adjuntos y original), la CLI (`@alimzen/relayo-cli`, comando `relayo`) con la GitHub Action `actions/sim`, y la landing con el despliegue (Docker + Caddy, `relayo-sim/deploy`). Hechos también el despliegue en relayo.alimzen.com (Dokploy, CI/CD), límites por plan, retención y recuperación de contraseña. **La plataforma como proveedor:** el mismo proyecto tiene claves de prueba (`rly_test_`, simulan) y en vivo (`rly_live_`, entregan por las conexiones del proyecto: SES, SendGrid, Resend, Postmark, Mailgun, SMTP y Twilio para SMS, con failover, eventos normalizados y supresiones), más el envío propio de Relayo con dominios verificados y DKIM (registrados en SES con BYODKIM); en la librería, `@alimzen/relayo-cloud`. La plataforma tiene además WhatsApp por Twilio, plantillas con variables, envíos programados (`sendAt`), `Idempotency-Key`, registro de entregas del webhook con reenvío, equipos (admin y miembro, invitaciones por email), verificación de email, revisión del envío de Relayo por administradores, límite de envíos reales, circuit breaker por conexión y rotación de `SECRETS_KEY`. En el contrato del core: `template` y `sendAt` en los mensajes, con la capacidad `templates`. Después: borrar cuenta y exportar datos, verificación en dos pasos, claves con permisos, planes por proyecto, auditoría y registro de peticiones, varios endpoints de webhook con filtros, envíos en lote, enlaces de baja (`List-Unsubscribe` en un clic), seguimiento de aperturas y clics, entregabilidad con avisos y recepción de correos (webhook `inbound`). Pendiente: usuarios beta.

## Stack

- Librería: TypeScript, Node 20+, salida dual ESM/CJS con `tsup`.
- Monorepo: pnpm workspaces + Changesets (Turborepo solo si crece).
- Validación de entrada: Zod o Valibot.
- Simulador: NestJS, `smtp-server` (Node), BullMQ para eventos asíncronos, panel en Angular.

## Contratos de la fase 0 (v0, sujetos a ajuste)

La fuente de verdad de los tipos es `packages/core/src/types/`. Resumen:

### Modelo de mensaje

Núcleo común pequeño más una vía de escape por proveedor (`providerOptions`). `metadata` debe viajar hasta todos los eventos para que la app sepa a qué registro corresponde cada uno. Ver `types/message.ts` (`Recipient`, `BaseMessage`, `EmailMessage`, `SmsMessage`, `Attachment`).

### Taxonomía de eventos

Ver `types/events.ts` (`RelayoEvent`, `EventType`, `BounceEvent`, `BounceReason`).

| Evento | Significado | Acción típica de la app |
| --- | --- | --- |
| `rejected` | El proveedor ni lo intentó (supresión, destinatario inválido) | No reintentar |
| `deferred` | Fallo temporal, el proveedor reintentará | Esperar |
| `bounced` hard | Fallo permanente del destinatario | Marcar contacto inválido |
| `bounced` soft | Agotó reintentos por fallo temporal | Reintentar más tarde o alertar |
| `bounced` block | Rechazo por política o reputación | Revisar configuración propia, no el contacto |
| `failed` | Error de Relayo o del proveedor al enviar | Reintentar o failover |

`block` va separado de `hard` a propósito: mezclarlos hace que la app marque como inválidos contactos que están bien cuando el problema real es la IP o el DKIM del remitente.

### Resultado de envío y errores

La bandera `retryable` es la base de los reintentos y del failover. Ver `errors.ts`:

- `ValidationError`, `AuthenticationError`, `RejectedError`, `WebhookVerificationError` → `retryable: false`
- `RateLimitError` (`retryAfter?`), `ProviderUnavailableError` → `retryable: true`

### Interfaz de drivers

`capabilities` permite que el core avise temprano si un driver no soporta algo y que el failover elija solo proveedores compatibles. Ver `types/driver.ts`.

**Ajuste respecto al borrador v0:** `send(message, context)` recibe un `SendContext` con el `messageId` generado por el core. Así el id de Relayo es estable entre proveedores (y a través del failover), y cada driver lo adjunta al mensaje del proveedor (cabecera, custom args, tags…) para poder mapear los webhooks de vuelta.

**Ajuste:** `SendResult.rejectedRecipients?: string[]` recoge los destinatarios que el proveedor rechazó en el momento mientras aceptaba el resto (típico en SMTP, donde cada `RCPT TO` tiene su propia respuesta).

### Driver SMTP (`@alimzen/relayo-smtp`)

- Sobre Nodemailer 10. Acepta URL de conexión, opciones SMTP/pool de Nodemailer o un transporter ya creado.
- Fija `Message-ID: <messageId@dominio-del-remitente>` y la cabecera `X-Relayo-Message-ID`, para que los DSN de rebote asíncronos se puedan asociar al envío original.
- Mapeo de errores: respuesta 5xx → `RejectedError`; 4xx → `ProviderUnavailableError`, o `RateLimitError` si el texto o el código ampliado indican limitación; `EAUTH`/535 → `AuthenticationError`; errores de red/TLS/DNS/timeout → `ProviderUnavailableError`; configuración o sobre inválido sin respuesta del servidor → `ValidationError`. Los detalles SMTP (`responseCode`, `enhancedCode`, `response`, `rejected`) quedan en `error.raw`.
- Sin webhooks: los rebotes posteriores llegan como DSN al remitente del sobre. Parsear DSN (RFC 3464) queda pendiente; servirá también para Relayo Sim.

### Failover (`failover()` en el core)

```ts
createRelayo({
  email: failover([ses({ region: 'us-east-1' }), smtp(process.env.SMTP_URL)], {
    onFailover: ({ from, to, error }) => log.warn({ from, to, code: error.code }),
  }),
});
```

- Prueba los drivers en orden. Pasa al siguiente solo ante errores `retryable` (caída, rate limit); con `ValidationError`, `AuthenticationError` o `RejectedError` se detiene, porque otro proveedor no lo arreglaría.
- Errores que no son `RelayoError` (un bug en un driver) **no** hacen failover: podrían ocurrir después de que el proveedor aceptara el mensaje, y cambiar de proveedor provocaría un envío doble. Se puede cambiar con `shouldFailover`.
- Todos los intentos usan el mismo `messageId` de Relayo; `SendResult.provider` indica qué driver lo envió.
- Se salta los drivers que no tienen una capacidad que el mensaje necesita (hoy: adjuntos). Las capacidades del compuesto son la unión de las de sus drivers; `batch` es `false` y el core envía mensaje a mensaje, cada uno con su propio failover.
- Si todos fallan, se lanza el último error (conserva p. ej. `retryAfter`).
- Webhooks: se enrutan al driver indicado en `req.provider` (recomendado: uno por endpoint, `/webhooks/ses`); sin él, al primer driver cuya verificación de firma acepte la petición. Si no puede saberse, error explícito pidiendo `provider`.
- Los nombres de los drivers deben ser únicos dentro de un failover (se usan para enrutar).

**Ajuste al contrato:** `WebhookRequest.provider?: string`.

Pendiente para la fase 4 (enrutamiento): circuit breaker para no insistir en un proveedor caído, pesos/porcentajes y reglas por mensaje.

### Clasificación de rebotes (`classifyBounce` en el core)

Función compartida por todos los drivers (y por el futuro lector de DSN y el simulador): recibe código SMTP, código ampliado (RFC 3463) y texto de diagnóstico, y devuelve `bounceType` + `reason`. Reglas clave:

- Causas del lado del remitente (política, lista negra/reputación, SPF/DKIM/DMARC, contenido, tamaño, rate limit) → siempre `block`, aunque el código sea 5xx.
- Un `5.7.1` genérico se afina con el texto: "blocked using Spamhaus" → `reputation_block`; "DMARC policy" → `auth_failure`.
- Buzón lleno → siempre `soft`.
- `X.1.10`: el RFC 7505 lo reserva para un dominio sin MX ("null MX"), pero Microsoft 365 también lo usa para usuarios inexistentes (`RecipientNotFound`); decide el texto.
- Fallo permanente sin más información → `hard` con `reason: 'unknown'`.

**Ajuste al contrato:** nuevo `RejectEvent` (`type: 'rejected'`, `reason: 'suppressed' | 'invalid_recipient' | 'content_rejected' | 'unknown'`).

### Driver SES (`@alimzen/relayo-ses`)

- Envío con SESv2 (`SendEmail`, contenido `Simple` con cabeceras y adjuntos). Resultado `status: 'queued'`.
- El id de Relayo viaja como tag `relayo_message_id` y como cabecera `X-Relayo-Message-ID`; `metadata` en la cabecera `X-Relayo-Metadata` (JSON en base64url, visible para el destinatario; desactivable con `metadataHeader: false`). Los `tags` de Relayo se convierten en tags de SES (caracteres no válidos → `_`).
- Eventos por SNS: verificación de firma (v1 SHA1 y v2 SHA256, certificado solo de `sns.<región>.amazonaws.com`, caché por URL), lista opcional de `topicArns` y confirmación automática de la suscripción. También acepta eventos de EventBridge o el evento SES directo (con `verifySignature: false`).
- Mapeo: Send→`accepted`, Delivery→`delivered`, DeliveryDelay→`deferred`, Reject→`rejected`, Bounce→`bounced` (con `classifyBounce` + subtipo de SES), supresión (`OnAccountSuppressionList`/`Suppressed`, también en quejas)→`rejected/suppressed`, Complaint→`complained`, Open→`opened`, Click→`clicked` (con `url`), Rendering Failure→`failed`, Subscription con `unsubscribeAll`→`unsubscribed`.
- Ids de evento `snsMessageId:índice`: estables ante reintentos de SNS, sirven para deduplicar.
- Los fixtures (`packages/ses/test/fixtures/ses-events.json`) siguen los ejemplos de la documentación de AWS; hay que sustituirlos por payloads capturados de una cuenta real.

### Driver SendGrid (`@alimzen/relayo-sendgrid`)

- API v3 (`POST /v3/mail/send`) con `fetch`, sin SDK ni dependencias en runtime. Región `eu` para cuentas con residencia de datos en la UE, `sandbox` para validar sin entregar, timeout configurable (30 s por defecto). Resultado `status: 'queued'` con `X-Message-Id` como `providerMessageId`.
- El id de Relayo y `metadata` viajan como `custom_args` (`relayo_message_id`, `relayo_metadata` en JSON): SendGrid los repite en cada evento y **no** son visibles para el destinatario, a diferencia de la cabecera de SES. Los `tags` se convierten en categorías (máximo 10; si hay más, `ValidationError` antes de llamar a la API).
- Errores HTTP: 401/403 → `AuthenticationError` (incluye remitente no verificado), 429 → `RateLimitError` con `retryAfter` sacado de `X-RateLimit-Reset`, 5xx y fallos de red → `ProviderUnavailableError`, resto de 4xx → `ValidationError`.
- Event Webhook firmado: ECDSA P-256 sobre `timestamp + cuerpo en bruto`; **necesita `rawBody`**. La clave se acepta en base64 (tal como la muestra SendGrid) o PEM. Sin `publicKey` falla con un error explícito salvo `verifySignature: false`. Tolerancia de timestamp opcional (`toleranceSeconds`) contra replays; desactivada por defecto porque no está claro que SendGrid vuelva a firmar los reintentos.
- Mapeo: processed→`accepted`, delivered, deferred, bounce→`bounced`, dropped→`rejected` (motivo `suppressed` / `invalid_recipient` / `unknown`), spamreport→`complained`, open, click (con `url`), unsubscribe y group_unsubscribe→`unsubscribed`. `group_resubscribe` se ignora.
- Rebotes: `classifyBounce` afinado con `bounce_classification`. Content, Reputation y Frequency or Volume → `block` aunque el código sea 5xx; un `type: "blocked"` nunca queda como `hard`.
- Ids de evento = `sg_event_id`, estable para deduplicar.
- Fixtures en `packages/sendgrid/test/fixtures/events.json`, basados en los ejemplos de la documentación de SendGrid; sustituir por capturas reales.

### Módulo NestJS (`@alimzen/relayo-nestjs`)

```ts
// main.ts: rawBody es necesario para verificar firmas (SendGrid, SNS)
const app = await NestFactory.create(AppModule, { rawBody: true });

// app.module.ts
RelayoModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    email: failover([ses({ region: 'eu-west-1' }), sendgrid({ apiKey: config.getOrThrow('SENDGRID_KEY') })]),
  }),
  webhooks: true, // POST /webhooks/relayo/:channel[/:provider]
});

// cualquier provider
@Injectable()
export class BillingService {
  constructor(private readonly relayo: RelayoService) {}

  @OnRelayoEvent('bounced')
  async onBounce(event: BounceEvent) { /* event.bounceType, event.metadata.facturaId */ }
}
```

- Compatible con NestJS 11 y 12 (peer `^11 || ^12`), Express y Fastify. Probado con 12.1.3 en los tests y con 11.2.7 instalando los paquetes empaquetados (ESM y CJS).
- **NestJS 12 es solo ESM.** Un proyecto CJS con Nest 12 necesita Node ≥ 20.19 o ≥ 22.12 (`require()` de ESM). Con Nest 11 no hay restricción.
- Módulo global por defecto (`isGlobal`). `RelayoService` implementa la misma interfaz que `Relayo`; el token `RELAYO_CLIENT` da la instancia directa.
- `@OnRelayoEvent(...tipos)` (o `'*'`) en métodos de providers singleton; se registran en `onApplicationBootstrap` y se dan de baja al cerrar la app. En providers con scope de request se ignora con un aviso.
- Controlador de webhooks **desactivado por defecto** (`webhooks: true` o `{ path }`). Respuestas: 200 `{ received }`, 401 si falla la firma, 400 si el payload o el canal no son válidos, 500 si un handler lanza (el proveedor reintentará: los handlers deben ser idempotentes usando `event.id`). Usa `/:channel/:provider` con `failover()`.
- Cuerpo en bruto: usa `req.rawBody` (`rawBody: true`); en Express lee del stream los cuerpos que ningún parser consumió (SNS envía JSON como `text/plain`). Si una firma falla sin cuerpo en bruto, avisa una vez en el log de cómo activarlo.
- El código del módulo usa `@Inject(token)` explícito porque esbuild (tsup, Vitest) no emite `emitDecoratorMetadata`; en las apps compiladas con `tsc`, `RelayoService` se inyecta por tipo con normalidad.

### Drivers Resend, Postmark y Mailgun

Mismo patrón que SendGrid: `fetch` sin SDK ni dependencias, errores con `retryable`, webhooks verificados y normalizados con `classifyBounce` afinado con los datos de cada proveedor. Formatos de envío, errores, eventos y firmas comprobados en la documentación oficial de cada uno (octubre 2026); los fixtures se construyeron a partir de esos campos y conviene sustituirlos por capturas reales.

| | Resend | Postmark | Mailgun |
| --- | --- | --- | --- |
| Envío | `POST /emails` JSON | `POST /email` JSON | `POST /v3/{dominio}/messages` form-data, US/EU |
| Id y `metadata` | tags (`metadata` en base64url, ≤256 caracteres) | `Metadata` nativo | `v:` user-variables |
| Firma de webhooks | Svix (HMAC-SHA256 de `id.timestamp.cuerpo`) | **ninguna**: autenticación básica en la URL | HMAC-SHA256 de `timestamp+token`, dentro del JSON |
| Tags | sin límite práctico | **uno** por mensaje | **tres** por mensaje |
| `idempotencyKey` | sí (`Idempotency-Key`, 24 h) | no | no |
| Particularidades | 429 de cuota diaria → `retryAfter` hasta medianoche UTC; rebotes con los subtipos de SES | ErrorCode 406 (destinatario inactivo) → `RejectedError`; tipos propios de bounce (`Blocked`, `DMARCPolicy` → `block`) | `failed` temporal → `deferred`; `suppress-*` → `rejected`; `old` nunca `hard` |

### Rebotes por correo (`@alimzen/relayo-bounces`)

Cierra el caso del correo propio por SMTP, que no tiene webhooks: `parseBounceEmail(raw)` convierte el correo que llega al buzón de rebotes en eventos Relayo.

- DSN (RFC 3464): `failed` → `bounced` (con `classifyBounce`), `delayed` → `deferred`, `delivered`/`relayed`/`expanded` → `delivered`. Un evento por destinatario.
- ARF (RFC 5965): `abuse`, `fraud`, `virus`, `other` → `complained`; `not-spam` y `auth-failure` se ignoran. Si el feedback loop oculta el destinatario, `recipient` es `''` pero el `messageId` sigue identificando el envío.
- Rebotes no estándar con `X-Failed-Recipients` (Exim, Gmail…) → `bounced`. Respuestas automáticas (fuera de oficina) → `kind: 'auto-reply'`, sin eventos.
- Enlace con el envío: cabeceras citadas del original (`X-Relayo-Message-ID`, `X-Relayo-Metadata`) o, en su defecto, el `Message-ID` `<id@dominio>` que pone el driver SMTP.
- Ids de evento derivados del informe: procesar el mismo buzón dos veces da los mismos ids.
- Parser MIME propio, mínimo y sin dependencias (multipart, base64, quoted-printable, `message/rfc822`, `text/rfc822-headers`). Fixtures `.eml` escritos a mano según los formatos de Postfix, Gmail, Microsoft 365, Exim y ARF: sustituir por capturas reales cuando las haya.
- Lectura automática del buzón: `@alimzen/relayo-imap` (`bounceMailbox({ connection }).watch(e => relayo.emit(e))`), sobre ImapFlow 2. Cada pasada abre y cierra su conexión, lee los no leídos y marca, mueve o borra cada mensaje solo después de que el handler haya procesado sus eventos; si falla, el mensaje queda sin leer y se reintenta (entrega al menos una vez, ids estables para deduplicar). Probado contra `hoodiecrow-imap`, un servidor IMAP en memoria. Sin IDLE: sondeo por intervalo, suficiente para rebotes.

El driver SMTP añade para esto `X-Relayo-Metadata` (desactivable con `metadataHeader: false`) y la opción `bounceAddress` (remitente del sobre). Nodemailer sustituye el sobre completo, así que el driver vuelve a listar los destinatarios: probado contra un servidor SMTP real, sin filtrar el Bcc.

### Reintentos en el core (ADR 6)

`createRelayo({ retry: { attempts, minDelayMs, maxDelayMs, factor, jitter, onRetry } })`, desactivado por defecto. Solo reintenta errores `retryable`, con backoff exponencial y jitter y el mismo `messageId`. Un `RateLimitError` espera su `retryAfter`, o se lanza si supera `maxDelayMs` (que lo gestione la cola). Con `failover()`, cada intento recorre todos los proveedores. En `sendBatch` se aplica mensaje a mensaje, nunca a un lote nativo (reenviaría los que sí salieron).

### Baja con un clic

`EmailMessage.unsubscribe: { url?, mailto?, oneClick? }`: el core genera `List-Unsubscribe` y, para urls https, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058, exigido por Gmail y Yahoo a los envíos masivos). Funciona con todos los drivers porque se convierte en cabeceras antes de llegar a ellos. No se puede combinar con cabeceras `List-Unsubscribe` escritas a mano. `listUnsubscribeHeaders()` está exportado para quien construya las cabeceras por su cuenta.

### Errores entre copias del core

Si una app acaba con dos copias de `@alimzen/relayo` (build ESM y CJS a la vez, o dos versiones), `instanceof` fallaría y, por ejemplo, un error de firma se trataría como un 500. Los `RelayoError` llevan una marca global (`Symbol.for('@alimzen/core:error')`, con el nombre antiguo del paquete a propósito: así también se reconocen los errores de copias publicadas como `@alimzen/core`) y `instanceof` reconoce por marca y `code` los errores de otra copia. Las subclases definen `static readonly code`.

### Versiones y publicación

- Con el peer `workspace:^`, Changesets publicaba los drivers como **1.0.0** ya en la primera versión (el core quedaba en 0.1.0) y volvía a subirlos de major con cada minor del core. Comprobado con `changeset version` en una copia del repo.
- Solución adoptada: los drivers declaran el peer `@alimzen/relayo: ">=0.1.0 <1.0.0"` (rango explícito; el enlace local sigue viniendo de la `devDependency` `workspace:^`) y Changesets usa `onlyUpdatePeerDependentsWhenOutOfRange`. Resultado comprobado: primera versión 0.1.0 en los cinco paquetes, y después cada paquete sube por su cuenta.
- Contrapartida: durante 0.x el rango acepta cualquier core 0.x, así que npm no avisará si un core con cambios incompatibles se combina con un driver antiguo. Regla: un changeset que rompa el contrato del core debe incluir también los drivers afectados. Al llegar a 1.0, cambiar el peer a `^1.0.0`.
- `publishConfig.exports` quita la condición `@alimzen/source` (apunta a `src/`, que no se publica) de los paquetes publicados.
- La provenance de npm solo puede generarse desde CI; no va en `publishConfig` para que la publicación manual funcione.

### Cómo publicar

**Primera vez (manual, antes de subir los workflows a GitHub):** requiere ser miembro con permiso de publicación de la org `alimzen` en npm y una cuenta con 2FA.

```sh
npm login
pnpm install && pnpm test && pnpm build
pnpm changeset version        # 0.1.0 + CHANGELOG.md por paquete; consume los changesets
git add -A && git commit -m "Release 0.1.0"
pnpm release                  # build + changeset publish (pide el código 2FA) y crea las etiquetas
git push --follow-tags
```

Al subir, el workflow `Release` no encuentra changesets pendientes y las versiones ya están en npm, así que no hace nada.

**Después (automático):** configurar en npmjs.com, para cada paquete, Settings → Trusted Publisher → GitHub Actions (`Alimzen/relayo`, workflow `release.yml`). A partir de ahí, cada cambio publicable lleva su `pnpm changeset`. Al llegar a `main`, el workflow abre o actualiza un PR "Version packages", y al mergearlo publica en npm con provenance. Si se prefiere un token en lugar de trusted publishing, guardarlo como secreto `NPM_TOKEN` del repo.

**CI:** `ci.yml` ejecuta typecheck, build y tests en Node 20, 22 y 24 en cada push a `main` y en cada PR.

## API objetivo (cómo debe sentirse)

```ts
const relayo = createRelayo({
  email: failover([ses({ region: 'us-east-1' }), sendgrid({ apiKey: '...' })]),
  sms: twilio({ accountSid: '...', authToken: '...' }),
});

await relayo.email.send({
  from: { address: 'facturas@empresa.com' },
  to: { address: 'cliente@empresa.com' },
  subject: 'Tu factura de octubre',
  html: '<p>...</p>',
  metadata: { facturaId: '123' },
});

relayo.on('bounced', (e) => { /* e.bounceType, e.reason, e.metadata */ });
```

En NestJS: `RelayoModule.forRoot({...})`, `RelayoService` inyectable y decorador `@OnRelayoEvent('bounced')`. En pruebas/CI se cambia el driver por `simulator({ apiKey })` sin tocar código de negocio.

## Relayo Sim (referencia para la fase 2)

Selección de escenario por dirección mágica, cabecera `X-Sim-Scenario` o reglas configurables (incluido modo caos por porcentaje).

```text
hard-bounce@sim.relayo.dev    → 550 5.1.1 usuario no existe
mailbox-full@sim.relayo.dev   → 452 4.2.2 buzón lleno
greylist+3@sim.relayo.dev     → acepta al tercer intento
blocked@sim.relayo.dev        → 550 5.7.1 bloqueado por política
complaint@sim.relayo.dev      → entrega y luego queja de spam
delay+30m@sim.relayo.dev      → entrega tras 30 minutos
```

Otros escenarios previstos: dominio sin MX, rate limiting (421), fallo SPF/DKIM/DMARC (550 5.7.26), mensaje demasiado grande (552 5.3.4), timeout, caída en spam, respuesta automática fuera de oficina, baja, aperturas y clics, lista de supresión. Los rebotes asíncronos se emiten como DSN (RFC 3464) y como webhooks con el formato de cada proveedor emulado.

## Decisiones (ADRs)

1. Monorepo con pnpm workspaces + Changesets. **Decidido (recomendado).**
2. Salida dual ESM/CJS con `tsup` (muchos proyectos NestJS siguen en CJS). **Decidido (recomendado).**
3. Node mínimo 20. **Decidido (recomendado).**
4. Validación con Zod o Valibot en el core. **Por elegir la librería.** (Mientras tanto, `src/validate.ts` hace comprobaciones a mano.)
5. Plantillas fuera del core en v1: se acepta `html`/`text` ya renderizado; más adelante `@alimzen/relayo-templates`. **Pendiente de confirmar.**
6. Reintentos: el core los expone como configuración opcional, desactivados por defecto (en producción suelen vivir en una cola como BullMQ y duplicarlos genera envíos dobles). **Decidido (recomendado).**

## Validación con usuarios (en paralelo a la fase 0)

Entrevistar a 5–8 personas que envíen correo o SMS en producción. No describir Relayo antes de que respondan. Preguntas:

1. ¿Qué proveedores usan hoy y por qué?
2. ¿Han cambiado de proveedor? ¿Cuánto costó?
3. ¿Cómo procesan rebotes, quejas y bajas? ¿Quién escribió esa lógica?
4. ¿Cómo prueban que su sistema reacciona bien a un rebote o bloqueo?
5. ¿Cuál fue el último problema de entregabilidad que los afectó en producción?
6. Si pudieran simular cualquier escenario, ¿cuál probarían primero?
7. ¿Pagan hoy por alguna herramienta de pruebas de correo?

Las preguntas 4 y 5 son las decisivas.

## Primeros pasos en el repo

1. ~~Crear el monorepo (pnpm + Changesets + tsup + TypeScript estricto + Vitest).~~
2. ~~Crear `packages/core` con los tipos (mensajes, eventos, errores, `Driver`).~~
3. ~~Implementar `createRelayo` con un driver en memoria para tests.~~
4. ~~Implementar `@alimzen/relayo-smtp` como primer driver real (sobre Nodemailer) y luego `@alimzen/relayo-ses`.~~
5. Escribir tests de normalización de webhooks con payloads reales de cada proveedor.
