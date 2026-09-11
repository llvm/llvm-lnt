# This file sets up the app's runtime secrets in Secrets Manager. For now that is just the
# Cloudflare origin certificate and private key that Nginx serves.
resource "aws_secretsmanager_secret" "app" {
  name = "${var.resource_prefix}/secrets"

  # Delete immediately on destroy: the contents are derived state that this module regenerates from
  # scratch, so there is nothing to recover. Keeping a window breaks the ability to teardown the
  # stack and re-apply without manual intervention.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    certificate = cloudflare_origin_ca_certificate.origin.certificate
    private_key = tls_private_key.origin.private_key_pem
  })
}
