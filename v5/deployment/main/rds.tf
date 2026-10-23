# This file provisions the Postgres database that the app talks to. It is a private RDS instance
# only accessible by the app instance.
#
# It is automatically backed up every day and backups are kept for 7 days.
#
# In production, the database can't be deleted without first turning off deletion protection, and
# deleting it takes a final snapshot and keeps the automated backups. Other environments are deleted
# outright, so that they can be torn down without any manual step.
#
# The master password is generated here and stored in the app's secret (see secrets.tf). It is
# deliberately static rather than managed by RDS, which rotates it automatically, because the app
# instance only reads it when it boots.
resource "aws_db_subnet_group" "main" {
  name       = local.stack_name
  subnet_ids = data.aws_subnets.default.ids
}

# RDS rejects some special characters in passwords, so stick to letters and digits.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = local.stack_name
  engine         = "postgres"
  engine_version = "18" # keep in sync with the version pinned for development
  instance_class = "db.t4g.micro"

  allocated_storage = 20 # 20gb for the initial deployment
  storage_encrypted = true

  db_name  = "lnt"
  username = "lnt"

  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  publicly_accessible = false

  deletion_protection       = local.is_production
  skip_final_snapshot       = !local.is_production
  final_snapshot_identifier = local.is_production ? "${local.stack_name}-final" : null

  backup_retention_period  = 7
  delete_automated_backups = !local.is_production
}
