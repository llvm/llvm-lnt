variable "aws_region" {
  description = "AWS region the v5 stack lives in. Must match deployment/bootstrap and backend.tf."
  type        = string
  default     = "us-west-2"
}

variable "resource_prefix" {
  description = "Prefix for every named resource, followed by the workspace name. Must match deployment/bootstrap."
  type        = string
  default     = "lnt-v5"
}

variable "cdn" {
  description = "The CDN in front of the stack: `cloudflare` or `fastly`. See v5/docs/deployment.md."
  type        = string

  validation {
    condition     = contains(["cloudflare", "fastly"], var.cdn)
    error_message = "cdn must be `cloudflare` or `fastly`."
  }
}

# The Cloudflare variables are only used with Cloudflare. Leaving them empty is the same as leaving
# them unset, since that is what the deploy workflow passes when the environment does not set them.
variable "cloudflare_api_token" {
  description = "With Cloudflare, an API token with Zone:DNS:Edit + Zone:SSL and Certificates:Edit for the zone containing var.domain"
  type        = string
  sensitive   = true
  default     = null

  validation {
    condition     = var.cdn != "cloudflare" || (var.cloudflare_api_token != null && var.cloudflare_api_token != "")
    error_message = "cloudflare_api_token is required when cdn is `cloudflare`."
  }
}

variable "cloudflare_zone_id" {
  description = "With Cloudflare, the zone ID of the zone containing var.domain"
  type        = string
  default     = null

  validation {
    condition     = var.cdn != "cloudflare" || (var.cloudflare_zone_id != null && var.cloudflare_zone_id != "")
    error_message = "cloudflare_zone_id is required when cdn is `cloudflare`."
  }
}

variable "domain" {
  description = "Full domain name the site is served at"
  type        = string
}

variable "ghcr_image" {
  description = "GHCR image reference (without tag) for the app"
  type        = string
  default     = "ghcr.io/llvm/llvm-lnt-v5"
}

variable "app_image_tag" {
  description = "Tag of the app image (in the ghcr_image repository) to deploy."
  type        = string

  # Constrain it to what a Docker tag is actually allowed to contain, to prevent
  # mistakes and injection.
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$", var.app_image_tag))
    error_message = "app_image_tag must be a valid Docker tag."
  }
}
