terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Tag every resource with the environment it belongs to so we can see that at a glance.
  default_tags {
    tags = {
      Environment = terraform.workspace
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
