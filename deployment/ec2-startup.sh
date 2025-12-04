#!/bin/bash

#
# This is the startup script that gets executed when the EC2 instance running lnt.llvm.org
# is brought up. This script references some files under /etc/lnt that are put into place
# by cloud-init, which is specified in the Terraform configuration file.
#

set -e

echo "Installing docker"
sudo yum update -y
sudo yum install -y docker
docker --version

echo "Installing docker compose"
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
          -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

echo "Starting the Docker service"
sudo service docker start
sudo systemctl enable docker # also ensure the Docker service starts on reboot

if ! lsblk --output FSTYPE -f /dev/sdh | grep --quiet ext4; then
    echo "Formatting /dev/sdh -- this is a new EBS volume"
    sudo mkfs -t ext4 /dev/sdh
else
    echo "/dev/sdh already contains a filesystem -- reusing previous EBS volume"
fi

echo "Mounting EBS volume with persistent information at /persistent-state"
sudo mkdir /persistent-state
sudo mount /dev/sdh /persistent-state

echo "Creating folders to map volumes in the Docker container to locations on the EC2 instance"
sudo mkdir -p /persistent-state/var/lib/lnt
(cd /var/lib && ln -s /persistent-state/var/lib/lnt lnt)
sudo mkdir -p /persistent-state/var/lib/postgresql
(cd /var/lib && ln -s /persistent-state/var/lib/postgresql postgresql)
sudo mkdir -p /var/log/lnt # logs are not persisted

echo "Starting LNT service with Docker compose"
sudo docker compose --file /etc/lnt/compose.yaml               \
                    --file /etc/lnt/ec2-volume-mapping.yaml    \
                    --env-file /etc/lnt/compose.env            \
                    up --detach
