# The certificate Nginx serves to the CDN, so that traffic between the CDN and the origin is
# encrypted too. Its private key is generated here; how the certificate is obtained depends on the
# CDN (see cloudflare.tf and fastly.tf). The certificate and private key are stored in Secrets
# Manager (see secrets.tf), for the EC2 instance to read at boot.
resource "tls_private_key" "origin" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

locals {
  origin_certificate = var.cdn == "cloudflare" ? cloudflare_origin_ca_certificate.origin[0].certificate : tls_locally_signed_cert.origin[0].cert_pem
}
