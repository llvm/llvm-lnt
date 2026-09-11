# This file provisions the Postgres database that the app talks to. It is a private RDS instance
# only accessible by the app instance.
#
# It is automatically backed up every day and backups are kept for 7 days.
resource "aws_db_subnet_group" "main" {
  name       = var.resource_prefix
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_db_instance" "main" {
  identifier     = var.resource_prefix
  engine         = "postgres"
  engine_version = "18" # keep in sync with the version pinned for development
  instance_class = "db.t4g.micro"

  allocated_storage = 20 # 20gb for the initial deployment
  storage_encrypted = true

  db_name  = "lnt"
  username = "lnt"

  # AWS generates and stores the master password itself.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  publicly_accessible = false

  # TODO: This should be flipped once we have real data in the DB.
  skip_final_snapshot = true
  deletion_protection = false

  backup_retention_period = 7
}
