#
# Terraform file for deploying lnt.llvm.org.
#

provider "aws" {
  region = "us-west-2"
}

variable "lnt_db_password" {
  type        = string
  description = "The database password for the lnt.llvm.org database."
  sensitive   = true
}

variable "lnt_auth_token" {
  type        = string
  description = "The authentication token to perform destructive operations on lnt.llvm.org."
  sensitive   = true
}

data "cloudinit_config" "startup_scripts" {
  base64_encode = true
  part {
    filename     = "ec2-startup.sh"
    content_type = "text/x-shellscript"
    content      = templatefile("${path.module}/ec2-startup.sh.tpl", {
      __db_password__ = var.lnt_db_password,
      __auth_token__ = var.lnt_auth_token,
    })
  }

  part {
    filename     = "compose.yaml"
    content_type = "text/cloud-config"
    content      = file("${path.module}/../compose.yaml")
  }
}

resource "aws_instance" "docker_server" {
  ami           = "ami-0c97bd51d598d45e4" # Amazon Linux 2023 kernel-6.12 AMI in us-west-2
  instance_type = "t2.micro"
  key_name      = "test-key-name" # TODO
  tags = {
    Name = "lnt.llvm.org"
  }

  user_data_base64 = data.cloudinit_config.startup_scripts.rendered
}
