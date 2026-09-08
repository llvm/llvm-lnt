# This file has two jobs:
# 1. Generate a private key + CSR locally and get it signed by Cloudflare's Origin CA. The
#    resulting certificate and private key are stored in Secrets Manager (see secrets.tf),
#    for the EC2 instance to read at boot.
# 2. Point the domain at the instance: an A record, proxied through Cloudflare so TLS terminates
#    at their edge.
data "cloudflare_zone" "this" {
  zone_id = var.cloudflare_zone_id
}

locals {
  # Derive the record name used with Cloudflare from `var.domain`. We use the Cloudflare convention
  # of `@` for a top-level domain (e.g. lnt.example), and the subdomain otherwise (e.g. `lntv5` for
  # lntv5.example.com in the example.com zone).
  record_name = var.domain == data.cloudflare_zone.this.name ? "@" : trimsuffix(var.domain, ".${data.cloudflare_zone.this.name}")
}

resource "tls_private_key" "origin" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem

  subject {
    common_name = var.domain
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = [var.domain]
  request_type       = "origin-rsa"
  requested_validity = 5475
}

resource "cloudflare_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = local.record_name
  type    = "A"
  content = aws_eip.app.public_ip
  proxied = true
  ttl     = 1
}
