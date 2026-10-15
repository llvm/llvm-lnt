# The parts of the stack specific to Fastly, used when var.cdn is "fastly". Unlike with Cloudflare,
# nothing is configured on the CDN's side: DNS and the Fastly service are managed outside of this
# module, and the service's backend is pointed at the instance by hand (see v5/docs/deployment.md).
#
# 1. Sign the origin certificate with a private CA created here. Fastly is given the CA certificate
#    (the `origin_ca_certificate` output) to verify the origin with.
# 2. Look up Fastly's published IP ranges, which are the only ones the origin accepts traffic from
#    (see network.tf).
#
# The CA is configured on the Fastly service by hand, so anything that replaces it (tearing down the
# environment, or changing its domain) requires updating the service.
resource "tls_private_key" "origin_ca" {
  count = var.cdn == "fastly" ? 1 : 0

  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "origin_ca" {
  count = var.cdn == "fastly" ? 1 : 0

  private_key_pem       = tls_private_key.origin_ca[0].private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 5475 * 24
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name = "LNT origin CA for ${var.domain}"
  }
}

# Unlike Cloudflare's Origin CA, which is given the hostnames separately, a locally signed
# certificate gets its SANs from the request.
resource "tls_cert_request" "fastly_origin" {
  count = var.cdn == "fastly" ? 1 : 0

  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = [var.domain]

  subject {
    common_name = var.domain
  }
}

resource "tls_locally_signed_cert" "origin" {
  count = var.cdn == "fastly" ? 1 : 0

  cert_request_pem      = tls_cert_request.fastly_origin[0].cert_request_pem
  ca_private_key_pem    = tls_private_key.origin_ca[0].private_key_pem
  ca_cert_pem           = tls_self_signed_cert.origin_ca[0].cert_pem
  validity_period_hours = 5475 * 24
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth"]
}

data "http" "fastly_ip_ranges" {
  count = var.cdn == "fastly" ? 1 : 0

  url = "https://api.fastly.com/public-ip-list"

  request_headers = {
    Accept = "application/json"
  }

  lifecycle {
    postcondition {
      condition     = self.status_code == 200
      error_message = "Failed to fetch Fastly's public IP list: got HTTP ${self.status_code}."
    }
  }
}
