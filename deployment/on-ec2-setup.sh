#!/bin/bash

#
# This is the startup script that gets executed when the EC2 instance running lnt.llvm.org
# is brought up for the first time. This script references some files under /etc/lnt that
# are put into place by cloud-init, which is specified in the Terraform configuration file.
#
# This scripts sets up another service that is run on every boot of the EC2 instance and which
# effectively runs the actual LNT service.
#

set -e

echo "Installing docker"
yum update -y
yum install -y docker
docker --version

echo "Installing docker compose"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
     -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

if ! lsblk --output FSTYPE -f /dev/sdh | grep --quiet ext4; then
    echo "Formatting /dev/sdh -- this is a new EBS volume"
    mkfs -t ext4 /dev/sdh
else
    echo "/dev/sdh already contains a filesystem -- reusing previous EBS volume"
fi

echo "Setting up the LNT service (via Docker compose) to start on every boot"
cat <<EOF > /etc/systemd/system/lnt.service
[Unit]
Description=LNT instance via Docker Compose
Requires=docker.service
After=docker.service

[Service]
ExecStart=/bin/bash /etc/lnt/on-ec2-boot.sh
# Set the service type to simple to use journalctl for logging
Type=simple
# If we fail to start the Docker service, something's awfully wrong so avoid getting into a failure loop
Restart=no

[Install]
WantedBy=multi-user.target
EOF
systemctl enable lnt.service
systemctl start lnt.service
