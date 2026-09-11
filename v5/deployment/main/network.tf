data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Cloudflare's published IP ranges, so the origin only accepts traffic that actually came through
# Cloudflare's proxy.
data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_security_group" "ec2" {
  name        = "${var.resource_prefix}-ec2"
  description = "HTTPS/HTTP from Cloudflare only; no inbound SSH (use SSM instead)"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs
    content {
      description = "HTTPS from Cloudflare"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs
    content {
      description = "HTTP from Cloudflare (redirected to HTTPS)"
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
  name        = "${var.resource_prefix}-rds"
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
