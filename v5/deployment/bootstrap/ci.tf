# One-time trust setup for the automated deployment pipeline. This creates an IAM policy with
# just enough permissions to perform what the CI needs to do. Run it once manually.

# The environments the stack is deployed to. Each one is at the same time a GitHub Actions
# environment allowed to assume the deploy role, and a Terraform workspace of deployment/main.
locals {
  environments = toset(["production", "test"])
}

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

# Only the configured environments in the configured repository can assume this role. It is shared
# by all environments. Make sure to restrict which branches can deploy to each GitHub environment.
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
          "token.actions.githubusercontent.com:sub" = [for env in local.environments : "repo:${var.github_repo}:environment:${env}"]
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
        Resource = [for role in aws_iam_role.app : role.arn]
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
        Resource = concat(
          [for role in aws_iam_role.app : role.arn],
          [for profile in aws_iam_instance_profile.app : profile.arn],
        )
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
      # RDS needs its service-linked role, which it creates on behalf of the caller the first time an
      # RDS resource is created in the account.
      {
        Sid      = "RdsServiceLinkedRole"
        Effect   = "Allow"
        Action   = "iam:CreateServiceLinkedRole"
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = "rds.amazonaws.com"
          }
        }
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
