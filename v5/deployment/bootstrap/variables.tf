variable "aws_region" {
  description = "AWS region the v5 stack lives in. Must match deployment/main."
  type        = string
  default     = "us-west-2"
}

variable "state_bucket_name" {
  description = <<-EOT
    Name of the S3 bucket to create for holding deployment/main's Terraform state. S3 bucket names
    must be globally unique. Whatever is chosen here must also be set in deployment/main/backend.tf,
    which cannot read variables.
  EOT
  type        = string
  default     = "lnt-v5-terraform-state"
}

variable "resource_prefix" {
  description = "Prefix for the IAM resources created by this bootstrap."
  type        = string
  default     = "lnt-v5"
}

variable "github_repo" {
  description = "The `owner/name` of the GitHub repository allowed to assume the deploy role."
  type        = string
  default     = "llvm/llvm-lnt"
}

variable "github_environment" {
  description = "The GitHub Actions environment allowed to assume the deploy role."
  type        = string
  default     = "v5-production"
}
