#!/usr/bin/env sh
# Marks the packages published before the rename as deprecated, pointing to their new names.
# Run once, after `pnpm release` has published the @alimzen/relayo* packages (needs npm login with 2FA).
set -e
deprecate() {
  npm deprecate "$1" "Renamed to $2: install $2 instead (same code)."
}
deprecate @alimzen/core @alimzen/relayo
deprecate @alimzen/smtp @alimzen/relayo-smtp
deprecate @alimzen/ses @alimzen/relayo-ses
deprecate @alimzen/sendgrid @alimzen/relayo-sendgrid
deprecate @alimzen/resend @alimzen/relayo-resend
deprecate @alimzen/postmark @alimzen/relayo-postmark
deprecate @alimzen/mailgun @alimzen/relayo-mailgun
deprecate @alimzen/simulator @alimzen/relayo-simulator
deprecate @alimzen/bounces @alimzen/relayo-bounces
deprecate @alimzen/imap @alimzen/relayo-imap
deprecate @alimzen/nestjs @alimzen/relayo-nestjs
deprecate @alimzen/cli @alimzen/relayo-cli
echo "Done: the old names now show a deprecation notice on install."
