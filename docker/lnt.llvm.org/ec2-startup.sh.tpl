#!/bin/bash

#
# This is a template for the startup script that gets run on the EC2
# instance running lnt.llvm.org. This template gets filled in by the
# Terraform configuration file.
#

sudo yum update -y
sudo amazon-linux-extras install docker docker-compose-plugin -y
sudo service docker start
sudo usermod -a -G docker ec2-user
sudo chkconfig docker on

LNT_DB_PASSWORD=${__db_password__}
LNT_AUTH_TOKEN=${__auth_token__}
docker compose --file compose.yaml up
