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

resource "local_file" "docker-compose-file" {
  source = "../compose.yaml"
  filename = "${path.module}/compose.yaml"
}

resource "aws_instance" "docker_server" {
  ami           = "ami-0c97bd51d598d45e4" # Amazon Linux 2023 kernel-6.12 AMI in us-west-2
  instance_type = "t2.micro"
  key_name      = "test-key-name" # TODO
  tags = {
    Name = "lnt.llvm.org"
  }

  user_data = templatefile("${path.module}/ec2-startup.sh.tpl", {
    __db_password__ = var.lnt_db_password,
    __auth_token__ = var.lnt_auth_token,
  })
}
