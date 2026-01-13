#
# Terraform file for deploying lnt.llvm.org.
#

terraform {
  backend "s3" {
    bucket  = "lnt.llvm.org-terraform-state-prod"
    key     = "terraform.tfstate"
    region  = "us-west-2"
    encrypt = true
  }
}

locals {
  availability_zone = "us-west-2a"
}

provider "aws" {
  region = "us-west-2"
}

#
# Setup secrets and other variables
#
# Note that the LNT database password and the LNT authentication token for destructive actions
# must be stored in the AWS Secrets Manager under a secrets named `lnt.llvm.org-secrets`, and
# with the `lnt-db-password` and `lnt-auth-token` keys respectively. This secrets must exist
# in whatever AWS account is currently authenticated when running Terraform.
#
data "aws_secretsmanager_secret" "lnt_secrets" {
  name = "lnt.llvm.org-secrets"
}

data "aws_secretsmanager_secret_version" "lnt_secrets_latest" {
  secret_id = data.aws_secretsmanager_secret.lnt_secrets.id
}

locals {
  # The Docker image to use for the webserver part of the LNT service
  lnt_image     = "f0d69809f71daa5ab549771b7171cb9e2a1cd86a"

  # The port on the EC2 instance used by the Docker webserver for communication
  lnt_external_port = "80"

  # The database password for the lnt.llvm.org database.
  lnt_db_password = jsondecode(data.aws_secretsmanager_secret_version.lnt_secrets_latest.secret_string)["lnt-db-password"]

  # The authentication token to perform destructive operations on lnt.llvm.org.
  lnt_auth_token = jsondecode(data.aws_secretsmanager_secret_version.lnt_secrets_latest.secret_string)["lnt-auth-token"]
}

#
# Setup the EC2 instance
#
data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-ecs-hvm-*-kernel-*-x86_64"]
  }
}

data "cloudinit_config" "startup_scripts" {
  base64_encode = true

  part {
    filename     = "on-ec2-setup.sh"
    content_type = "text/x-shellscript"
    content      = file("${path.module}/on-ec2-setup.sh")
  }

  part {
    content_type = "text/cloud-config"
    content = yamlencode({
      write_files = [
        {
          path        = "/etc/lnt/compose.yaml"
          permissions = "0400" # read-only for owner
          content     = file("${path.module}/../docker/compose.yaml")
        },
        {
          path        = "/etc/lnt/ec2-volume-mapping.yaml"
          permissions = "0400" # read-only for owner
          content     = file("${path.module}/ec2-volume-mapping.yaml")
        },
        {
          path        = "/etc/lnt/compose.env"
          permissions = "0400" # read-only for owner
          content     = templatefile("${path.module}/compose.env.tpl", {
            __db_password__       = local.lnt_db_password,
            __auth_token__        = local.lnt_auth_token,
            __lnt_image__         = local.lnt_image,
            __lnt_external_port__ = local.lnt_external_port,
          })
        },
        {
          path        = "/etc/lnt/on-ec2-boot.sh"
          permissions = "0400" # read-only for owner
          content     = file("${path.module}/on-ec2-boot.sh")
        }
      ]
    })
  }
}

resource "aws_security_group" "server" {
  name        = "lnt.llvm.org/server-security-group"
  description = "Allow SSH and HTTP traffic"

  ingress {
    description = "Allow incoming SSH traffic from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Allow incoming HTTP traffic from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow outgoing traffic to anywhere"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "server" {
  ami                         = data.aws_ami.amazon_linux_2023.id
  availability_zone           = local.availability_zone
  instance_type               = "t2.small"
  security_groups             = [aws_security_group.server.name]
  tags = {
    Name = "lnt.llvm.org/server"
  }

  # Deploy the cloud-init files to the instance on creation. Also make sure that
  # changing the cloud-init data causes the instance to be re-created, otherwise
  # the files are not updated. This should probably be the default Terraform behavior.
  user_data_base64            = data.cloudinit_config.startup_scripts.rendered
  user_data_replace_on_change = true
}

# Allocate a stable elastic IP for the webserver
resource "aws_eip" "stable_ip" {
  instance = aws_instance.server.id
  domain   = "vpc"
}

output "web_server_public_ip" {
  value = aws_eip.stable_ip.public_ip
}

#
# Setup the EBS volume attached to the instance that stores the DB
# and other instance-related configuration (e.g. the schema files,
# profiles and anything else that should persist).
#
resource "aws_ebs_volume" "persistent_state" {
  availability_zone = local.availability_zone
  size              = 128 # GiB
  type              = "gp2"
  tags = {
    Name = "lnt.llvm.org/persistent-state"
  }
}

resource "aws_volume_attachment" "persistent_state_attachment" {
  instance_id = aws_instance.server.id
  volume_id   = aws_ebs_volume.persistent_state.id
  device_name = "/dev/sdh"
}
