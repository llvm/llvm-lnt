data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# The CDN's published IP ranges, so the origin only accepts traffic that actually came through the
# CDN. The origin only has an IPv4 address, so the IPv6 ranges are not needed.
locals {
  cdn_name       = var.cdn == "cloudflare" ? "Cloudflare" : "Fastly"
  cdn_ipv4_cidrs = var.cdn == "cloudflare" ? data.cloudflare_ip_ranges.cloudflare[0].ipv4_cidrs : jsondecode(data.http.fastly_ip_ranges[0].response_body).addresses
}

resource "aws_security_group" "ec2" {
  name = "${local.stack_name}-ec2"
  # Changing the description replaces the security group, so keep it stable for existing
  # environments.
  description = "HTTPS/HTTP from ${local.cdn_name} only; no inbound SSH (use SSM instead)"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = local.cdn_ipv4_cidrs
    content {
      description = "HTTPS from ${local.cdn_name}"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = local.cdn_ipv4_cidrs
    content {
      description = "HTTP from ${local.cdn_name} (redirected to HTTPS)"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.stack_name}-rds"
  description = "Postgres from the app instance only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Postgres from the app instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
