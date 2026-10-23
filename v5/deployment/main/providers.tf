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
    http = {
      source  = "hashicorp/http"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
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
  # Unused with Fastly, where the deploy workflow passes an empty token. The provider rejects an
  # empty token even when no resource uses it, but accepts none at all.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}
