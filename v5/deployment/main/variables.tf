variable "aws_region" {
  description = "AWS region the v5 stack lives in. Must match deployment/bootstrap and backend.tf."
  type        = string
  default     = "us-west-2"
}

variable "resource_prefix" {
  description = "Prefix for every named resource. This allows keeping a v5 stack disjoint from other deployments."
  type        = string
  default     = "lnt-v5"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone:DNS:Edit + Zone:SSL and Certificates:Edit for the zone containing var.domain)"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Zone ID in Cloudflare for the zone containing var.domain"
  type        = string
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
}
