---
'@alimzen/relayo': minor
'@alimzen/relayo-twilio': minor
---

WhatsApp through Twilio: SMS recipients can be written `whatsapp:+34600111222` (the core accepts the prefix) and the Twilio driver sends them from `whatsappFrom`. Approved templates go in `providerOptions.twilio` (`contentSid`, `contentVariables`) for messages outside the 24-hour window. Errors 63016 (outside the window) and 63003/63024 (no WhatsApp account) map to `rejected`.
