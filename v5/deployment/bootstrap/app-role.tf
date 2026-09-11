# The instance role for the app server, and the instance profile that hands it to EC2. It grants
# just enough to allow shell access via SSM and to fetch the secrets the app needs from Secrets
# Manager.
#
# This is done as part of bootstrapping instead of the main deployment pipeline since it makes it
# easier to bound the permissions given to the instance to prevent priviledge escalation.

resource "aws_iam_role" "app" {
  name = "${var.resource_prefix}-app"

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
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Use patterns instead of exact ARNs, because secrets are created by deployment/main and
# their names are not known yet.
resource "aws_iam_role_policy" "app_secrets" {
  name = "read-secrets"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "secretsmanager:GetSecretValue"
      Resource = [
        "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.resource_prefix}/*",
        "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*",
      ]
    }]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.resource_prefix}-app"
  role = aws_iam_role.app.name
}
