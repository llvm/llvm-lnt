# One-time trust setup for the automated deployment pipeline. This creates an IAM policy with
# just enough permissions to perform what the CI needs to do. Run it once manually.

data "aws_caller_identity" "current" {}

data "aws_kms_alias" "rds" {
  name = "alias/aws/rds"
}

data "aws_kms_alias" "secretsmanager" {
  name = "alias/aws/secretsmanager"
}

# The OIDC provider is account-wide: IAM allows only one per URL per account, so don't create one
# if it already exists and reuse the existing one instead.
locals {
  github_oidc_provider_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.manage_github_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# When reusing a provider we did not create, check that it accepts the audience the trust policy
# below requires. A set up for a different project in the same AWS account may list other audiences
# than the ones we need.
data "aws_iam_openid_connect_provider" "existing" {
  count = var.manage_github_oidc_provider ? 0 : 1

  url = "https://token.actions.githubusercontent.com"

  lifecycle {
    postcondition {
      condition     = contains(self.client_id_list, "sts.amazonaws.com")
      error_message = "The existing GitHub Actions OIDC provider does not list sts.amazonaws.com as an audience."
    }
  }
}

# Only the configured environment in the configured repository can assume this role.
resource "aws_iam_role" "github_actions_deploy" {
  name = "${var.resource_prefix}-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:${var.github_environment}"
        }
      }
    }]
  })

  depends_on = [aws_iam_openid_connect_provider.github_actions]
}

# IAM Policy allowing the use of the parts of AWS we need.
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
        Sid      = "IamPassAppRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-app"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ec2.amazonaws.com"
          }
        }
      },
      # Read-only, so that Terraform can resolve the instance profile it attaches to the instance.
      {
        Sid    = "IamReadAppRole"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:GetInstanceProfile",
        ]
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.resource_prefix}-app",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/${var.resource_prefix}-app",
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
