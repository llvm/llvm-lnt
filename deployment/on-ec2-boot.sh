#!/bin/bash

#
# This is the startup script that gets executed every time the EC2 instance running lnt.llvm.org
# boots. This script references some files under /etc/lnt that are put into place when the instance
# is initially set up (via cloud-init, see the Terraform configuration file).
#
# This arrangement ensures that the LNT service automatically restarts after a reboot of the EC2
# instance, which is useful since many operations don't require entirely tearing down the instance,
# in which case the instance only gets rebooted and should still be functional.
#

set -e

echo "Mounting EBS volume with persistent information at /mnt/lnt-persistent-state"
if ! findmnt --source /dev/sdh; then
    mkdir -p /mnt/lnt-persistent-state
    mount /dev/sdh /mnt/lnt-persistent-state
fi

echo "Creating necessary filesystem hierarchy on the persistent volume"
mkdir -p /mnt/lnt-persistent-state/var/lib/lnt
mkdir -p /mnt/lnt-persistent-state/var/lib/postgresql
mkdir -p /var/log/lnt # logs are not persisted

echo "Linking locations inside the persistent volume to the expected locations on the instance"
if [[ ! -e "/var/lib/lnt" ]]; then
    (cd /var/lib && ln -s /mnt/lnt-persistent-state/var/lib/lnt lnt)
fi
if [[ ! -e "/var/lib/postgresql" ]]; then
    (cd /var/lib && ln -s /mnt/lnt-persistent-state/var/lib/postgresql postgresql)
fi

echo "Starting LNT service with Docker compose"
docker compose --file /etc/lnt/compose.yaml                 \
               --file /etc/lnt/ec2-volume-mapping.yaml      \
               --env-file /etc/lnt/compose.env              \
               up
