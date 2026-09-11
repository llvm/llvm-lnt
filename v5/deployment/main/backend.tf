# Backend configuration. The name of the S3 bucket containing the Terraform
# state must match what was used when running the bootstrap -- it cannot be
# a variable so it must be hardcoded here.
terraform {
  backend "s3" {
    bucket       = "lnt-v5-terraform-state"
    key          = "main.tfstate"
    region       = "us-west-2"
    use_lockfile = true
    encrypt      = true
  }
}
