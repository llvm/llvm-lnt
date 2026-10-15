output "instance_public_ip" {
  value = aws_eip.app.public_ip
}

output "rds_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "origin_ca_certificate" {
  description = "With Fastly, the CA certificate the Fastly backend verifies the origin with."
  value       = var.cdn == "fastly" ? tls_self_signed_cert.origin_ca[0].cert_pem : null
}

output "url" {
  value = "https://${var.domain}"
}
