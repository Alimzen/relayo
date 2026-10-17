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
| Librería core | `@relayo/core` |
| Drivers | `@relayo/ses`, `@relayo/sendgrid`, `@relayo/smtp`, `@relayo/twilio` |
| Módulo NestJS | `@relayo/nestjs` |
| Simulador (SaaS) | Relayo Sim |
| Bandeja de captura | Relayo Inbox |
| Simulador de flujos | Relayo Flows |
| CLI | `relayo` |

Pendiente: reservar org `@relayo` en npm, org `relayo` en GitHub y dominio (`relayo.dev` / `relayo.io`); revisar registro de marca.

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

**Estado actual: fase 0.**

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

### Driver SMTP (`@relayo/smtp`)

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

### Driver SES (`@relayo/ses`)

- Envío con SESv2 (`SendEmail`, contenido `Simple` con cabeceras y adjuntos). Resultado `status: 'queued'`.
- El id de Relayo viaja como tag `relayo_message_id` y como cabecera `X-Relayo-Message-ID`; `metadata` en la cabecera `X-Relayo-Metadata` (JSON en base64url, visible para el destinatario; desactivable con `metadataHeader: false`). Los `tags` de Relayo se convierten en tags de SES (caracteres no válidos → `_`).
- Eventos por SNS: verificación de firma (v1 SHA1 y v2 SHA256, certificado solo de `sns.<región>.amazonaws.com`, caché por URL), lista opcional de `topicArns` y confirmación automática de la suscripción. También acepta eventos de EventBridge o el evento SES directo (con `verifySignature: false`).
- Mapeo: Send→`accepted`, Delivery→`delivered`, DeliveryDelay→`deferred`, Reject→`rejected`, Bounce→`bounced` (con `classifyBounce` + subtipo de SES), supresión (`OnAccountSuppressionList`/`Suppressed`, también en quejas)→`rejected/suppressed`, Complaint→`complained`, Open→`opened`, Click→`clicked` (con `url`), Rendering Failure→`failed`, Subscription con `unsubscribeAll`→`unsubscribed`.
- Ids de evento `snsMessageId:índice`: estables ante reintentos de SNS, sirven para deduplicar.
- Los fixtures (`packages/ses/test/fixtures/ses-events.json`) siguen los ejemplos de la documentación de AWS; hay que sustituirlos por payloads capturados de una cuenta real.

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
5. Plantillas fuera del core en v1: se acepta `html`/`text` ya renderizado; más adelante `@relayo/templates`. **Pendiente de confirmar.**
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
4. ~~Implementar `@relayo/smtp` como primer driver real (sobre Nodemailer) y luego `@relayo/ses`.~~
5. Escribir tests de normalización de webhooks con payloads reales de cada proveedor.
