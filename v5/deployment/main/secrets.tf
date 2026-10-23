# This file sets up the app's runtime secrets in Secrets Manager: the database password (see rds.tf),
# and the origin certificate and private key that Nginx serves (see origin-certificate.tf).
resource "aws_secretsmanager_secret" "app" {
  # deployment/bootstrap relies on this name to grant the instance access to it.
  name = "${var.resource_prefix}/${terraform.workspace}/secrets"

  # Delete immediately on destroy: the contents are derived state that this module regenerates from
  # scratch, so there is nothing to recover. Keeping a window breaks the ability to teardown the
  # stack and re-apply without manual intervention.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    db_password = random_password.db.result
    certificate = local.origin_certificate
    private_key = tls_private_key.origin.private_key_pem
  })
}
