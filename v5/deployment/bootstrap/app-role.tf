# The instance role for the app server of each environment, and the instance profile that hands it
# to EC2. It grants just enough to allow shell access via SSM and to fetch the environment's own
# secrets from Secrets Manager, so that an instance cannot read the secrets of another environment.
#
# This is done as part of bootstrapping instead of the main deployment pipeline since it makes it
# easier to bound the permissions given to the instance to prevent privilege escalation.

resource "aws_iam_role" "app" {
  for_each = local.environments

  name = "${var.resource_prefix}-${each.key}-app"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app_ssm" {
  for_each = local.environments

  role       = aws_iam_role.app[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Use patterns instead of exact ARNs, because secrets are created by deployment/main and their
# names are not known yet.
resource "aws_iam_role_policy" "app_secrets" {
  for_each = local.environments

  name = "read-secrets"
  role = aws_iam_role.app[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AppSecrets"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.resource_prefix}/${each.key}/*"
      },
      # The database password is in a secret that RDS creates and names itself, so it can't be
      # matched by name. Instead, match on the tag RDS puts on it, naming the DB instance that owns
      # it; deployment/main names that instance after the environment.
      {
        Sid      = "DatabaseSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*"
        Condition = {
          StringEquals = {
            "secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn" = "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${var.resource_prefix}-${each.key}"
          }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  for_each = local.environments

  name = "${var.resource_prefix}-${each.key}-app"
  role = aws_iam_role.app[each.key].name
}
