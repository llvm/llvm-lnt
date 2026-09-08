# One-time trust setup for the automated deployment pipeline. This creates an IAM policy with just
# enough permissions to perform what the CI needs to do. Run it once manually.

data "aws_caller_identity" "current" {}

data "aws_kms_alias" "rds" {
  name = "alias/aws/rds"
}

data "aws_kms_alias" "secretsmanager" {
  name = "alias/aws/secretsmanager"
}

# An AWS account can hold only one OIDC provider per URL, so this assumes the account does not
# already trust GitHub Actions.
resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Only the configured environment in the configured repository can assume this role.
resource "aws_iam_role" "github_actions_deploy" {
  name = "${var.resource_prefix}-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:${var.github_environment}"
        }
      }
    }]
  })
}

# IAM Policy allowing the use of roughly the parts of AWS we need.
resource "aws_iam_role_policy" "deploy_scoped" {
  name = "scoped-resources"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Secrets"
        Effect = "Allow"
        Action = "secretsmanager:*"
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.resource_prefix}/*",
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*",
        ]
      },
      {
        Sid    = "TerraformState"
        Effect = "Allow"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*",
        ]
      },
      {
        Sid    = "IamResources"
        Effect = "Allow"
        Action = "iam:*"
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/${var.resource_prefix}-*",
        ]
      },
      {
        Sid      = "Ec2"
        Effect   = "Allow"
        Action   = "ec2:*"
        Resource = "*"
      },
      {
        Sid      = "RDS"
        Effect   = "Allow"
        Action   = "rds:*"
        Resource = "*"
      },
      # Needed for RDS storage encryption (aws/rds) and the auto-generated master
      # password secret (aws/secretsmanager).
      {
        Sid    = "Kms"
        Effect = "Allow"
        Action = [
          "kms:CreateGrant",
          "kms:DescribeKey",
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey*",
        ]
        Resource = [
          data.aws_kms_alias.rds.target_key_arn,
          data.aws_kms_alias.secretsmanager.target_key_arn,
        ]
      },
    ]
  })
}
