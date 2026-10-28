---
layout: home

hero:
  name: Relayo
  text: Email and SMS, whatever the provider
  tagline: One API to send, and one normalized event model for everything that comes back — bounces, complaints, deferrals, unsubscribes.
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Packages
      link: /packages/core
    - theme: alt
      text: GitHub
      link: https://github.com/Alimzen/relayo

features:
  - title: One event model
    details: accepted, delivered, deferred, bounced, complained, rejected, opened, clicked, unsubscribed, failed — from SES, SendGrid, Resend, Postmark, Mailgun, SMTP or Twilio, each with the provider's original payload in raw.
  - title: Bounces you can act on
    details: hard, soft or block, with a reason. Remove bad addresses, fix your own setup on blocks, and stop marking good contacts invalid.
  - title: Your ids travel with the message
    details: Every event carries the messageId and the metadata of the send, so you always know which record it is about.
  - title: Failover that knows when to stop
    details: Errors say whether a retry can help. failover() switches providers on outages and rate limits, never on errors another provider would not fix.
  - title: Test the hard cases
    details: The memory driver for unit tests, and Relayo Sim for realistic bounces, greylisting and complaints in CI, with the relayo CLI and a GitHub Action.
  - title: Or let the platform do it
    details: relayo-cloud sends through the Relayo platform — hosted or your own, open source — with one key, one webhook, and your providers behind it.
---
