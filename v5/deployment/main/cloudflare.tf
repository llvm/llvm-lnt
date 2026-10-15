# The parts of the stack specific to Cloudflare, used when var.cdn is "cloudflare":
# 1. Get the origin certificate signed by Cloudflare's Origin CA, which Cloudflare trusts.
# 2. Point the domain at the instance: an A record, proxied through Cloudflare so TLS terminates
#    at their edge.
# 3. Look up Cloudflare's published IP ranges, which are the only ones the origin accepts traffic
#    from (see network.tf).
data "cloudflare_zone" "this" {
  count = var.cdn == "cloudflare" ? 1 : 0

  zone_id = var.cloudflare_zone_id
}

locals {
  # Derive the record name used with Cloudflare from `var.domain`. We use the Cloudflare convention
  # of `@` for a top-level domain (e.g. lnt.example), and the subdomain otherwise (e.g. `lntv5` for
  # lntv5.example.com in the example.com zone).
  record_name = var.cdn == "cloudflare" ? (var.domain == data.cloudflare_zone.this[0].name ? "@" : trimsuffix(var.domain, ".${data.cloudflare_zone.this[0].name}")) : null
}

resource "cloudflare_origin_ca_certificate" "origin" {
  count = var.cdn == "cloudflare" ? 1 : 0

  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = [var.domain]
  request_type       = "origin-rsa"
  requested_validity = 5475
}

resource "cloudflare_dns_record" "app" {
  count = var.cdn == "cloudflare" ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = local.record_name
  type    = "A"
  content = aws_eip.app.public_ip
  proxied = true
  ttl     = 1
}

data "cloudflare_ip_ranges" "cloudflare" {
  count = var.cdn == "cloudflare" ? 1 : 0
}
