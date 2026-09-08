output "state_bucket" {
  value       = aws_s3_bucket.terraform_state.bucket
  description = "Set this as the `bucket` in deployment/main/backend.tf."
}

output "github_actions_deploy_role_arn" {
  value       = aws_iam_role.github_actions_deploy.arn
  description = "Set this as the AWS_DEPLOY_ROLE_ARN GitHub Actions variable."
}
